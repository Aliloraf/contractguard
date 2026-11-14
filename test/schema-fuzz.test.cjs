// Randomised and metamorphic tests for schema comparison.
//
// Everything here is driven by a seeded generator, so a run is reproducible and
// a failure names the seed that produced it. Three properties are checked:
//
//   1. Respelling a schema without changing what it accepts yields no findings
//      and the same canonical form.
//   2. Two schemas with the same canonical form accept the same instances.
//   3. Whenever an instance proves a change is incompatible, the comparison
//      reports something. It may be a breaking change or a review notice, but
//      never silence.
//
// "Proves" is decided by a small reference validator that is independent of
// the engine: a request breaks when some instance was valid and no longer is,
// a response breaks when some instance is valid now and was not before.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareSpecifications } = require('../.build/comparator.js');
const { canonicalize, documentFor } = require('../.build/schema.js');

// --- Deterministic randomness ------------------------------------------------

function generator(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: probability => next() < probability,
    pick: list => list[Math.floor(next() * list.length)],
    shuffle: list => {
      const copy = [...list];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
  return rng;
}

// --- Reference validator -----------------------------------------------------

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function matchesType(type, value) {
  switch (type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'array': return Array.isArray(value);
    case 'object': return isObject(value);
    default: return false;
  }
}

function deref(schema, components) {
  let current = schema;
  while (isObject(current) && typeof current.$ref === 'string') {
    current = components[current.$ref.replace('#/components/schemas/', '')];
  }
  return current;
}

/** Validates the keyword subset the generator below produces (OpenAPI 3.0 style). */
function valid(rawSchema, value, components) {
  const schema = deref(rawSchema, components);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? [...schema.type] : [schema.type];
    if (schema.nullable === true) types.push('null');
    if (!types.some(type => matchesType(type, value))) return false;
  }
  if (schema.enum && !schema.enum.some(item => stable(item) === stable(value))) return false;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every(item => valid(schema.items, item, components))) return false;
  }
  if (isObject(value)) {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) return false;
    for (const [name, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        if (!valid(properties[name], item, components)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (isObject(schema.additionalProperties)) {
        if (!valid(schema.additionalProperties, item, components)) return false;
      }
    }
  }
  if (schema.allOf && !schema.allOf.every(branch => valid(branch, value, components))) return false;
  if (schema.anyOf && !schema.anyOf.some(branch => valid(branch, value, components))) return false;
  if (schema.oneOf && schema.oneOf.filter(branch => valid(branch, value, components)).length !== 1) return false;
  return true;
}

// --- Schema generation -------------------------------------------------------

// Annotation names are over-represented on purpose: they are legal property
// names and the ones most easily mistaken for metadata.
const PROPERTY_NAMES = ['id', 'name', 'title', 'description', 'default', 'example', 'examples', 'count'];
const STRING_VALUES = ['', 'a', 'bb', 'ccc', 'dddd', 'eeeee'];
const SCALAR_TYPES = ['string', 'integer', 'number', 'boolean'];

function annotate(rng, schema) {
  if (rng.chance(0.3)) schema.description = `text ${rng.int(0, 9)}`;
  if (rng.chance(0.15)) schema.title = `Title ${rng.int(0, 9)}`;
  if (rng.chance(0.1)) schema.default = rng.pick([null, 0, 'a', {}]);
  if (rng.chance(0.1)) schema.example = rng.pick([1, 'x', { title: 'sample' }]);
  return schema;
}

function scalar(rng, type = rng.pick(SCALAR_TYPES)) {
  const schema = { type };
  if (type === 'string') {
    if (rng.chance(0.3)) schema.minLength = rng.int(0, 2);
    if (rng.chance(0.3)) schema.maxLength = rng.int(2, 5);
    if (rng.chance(0.25)) schema.enum = rng.shuffle(STRING_VALUES).slice(0, rng.int(1, 3));
  } else if (type === 'integer' || type === 'number') {
    if (rng.chance(0.3)) schema.minimum = rng.int(-2, 2);
    if (rng.chance(0.3)) schema.maximum = rng.int(2, 6);
    if (rng.chance(0.2)) schema.enum = rng.shuffle([0, 1, 2, 3, 4]).slice(0, rng.int(1, 3));
  }
  if (rng.chance(0.1)) schema.nullable = true;
  return schema;
}

function objectSchema(rng, depth, refs) {
  const schema = { type: 'object' };
  const names = rng.shuffle(PROPERTY_NAMES).slice(0, rng.int(0, 3));
  if (names.length > 0 || rng.chance(0.5)) {
    schema.properties = {};
    for (const name of names) schema.properties[name] = schemaOf(rng, depth - 1, refs);
  }
  const required = names.filter(() => rng.chance(0.4));
  if (rng.chance(0.1)) required.push(rng.pick(PROPERTY_NAMES));
  if (required.length > 0) schema.required = [...new Set(required)];
  const extras = rng.next();
  if (extras < 0.2) schema.additionalProperties = false;
  else if (extras < 0.4) schema.additionalProperties = schemaOf(rng, 0, refs);
  else if (extras < 0.5) schema.additionalProperties = true;
  return schema;
}

function schemaOf(rng, depth, refs) {
  const roll = rng.next();
  let schema;
  if (depth <= 0 || roll < 0.3) schema = scalar(rng);
  else if (roll < 0.55) schema = objectSchema(rng, depth, refs);
  else if (roll < 0.65) {
    schema = { type: 'array', items: schemaOf(rng, depth - 1, refs) };
    if (rng.chance(0.3)) schema.minItems = rng.int(0, 2);
    if (rng.chance(0.3)) schema.maxItems = rng.int(1, 3);
  } else if (roll < 0.75) {
    schema = { anyOf: Array.from({ length: rng.int(1, 3) }, () => schemaOf(rng, depth - 1, refs)) };
  } else if (roll < 0.85) {
    schema = { oneOf: Array.from({ length: rng.int(1, 3) }, () => schemaOf(rng, depth - 1, refs)) };
  } else if (roll < 0.95) {
    // Mostly intersections that mean something: objects with objects, or a
    // typed schema with a bare constraint.
    const branches = rng.chance(0.6)
      ? Array.from({ length: rng.int(1, 3) }, () => objectSchema(rng, depth - 1, refs))
      : [scalar(rng, 'string'), rng.pick([{ minLength: rng.int(0, 2) }, { maxLength: rng.int(2, 5) }, { enum: ['a', 'bb'] }, {}])];
    schema = { allOf: branches };
    if (rng.chance(0.3)) schema.required = [rng.pick(PROPERTY_NAMES)];
  } else if (refs.length > 0) {
    return { $ref: `#/components/schemas/${rng.pick(refs)}` };
  } else schema = rng.chance(0.5) ? {} : scalar(rng);
  return annotate(rng, schema);
}

/** A root schema plus the components it may reference (never recursively). */
function generateCase(rng) {
  const components = {};
  const refs = [];
  for (let i = 0; i < rng.int(0, 3); i++) {
    components[`C${i}`] = schemaOf(rng, 2, refs);
    refs.push(`C${i}`);
  }
  return { schema: schemaOf(rng, 3, refs), components };
}

// --- Walking and rewriting ---------------------------------------------------

/** Calls `visit` for every schema object, in a stable order. */
function walk(schema, visit) {
  if (!isObject(schema)) return;
  visit(schema);
  for (const name of Object.keys(schema.properties ?? {})) walk(schema.properties[name], visit);
  walk(schema.items, visit);
  walk(schema.additionalProperties, visit);
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    for (const branch of schema[keyword] ?? []) walk(branch, visit);
  }
}

function nodesOf(testCase) {
  const nodes = [];
  walk(testCase.schema, node => nodes.push(node));
  for (const name of Object.keys(testCase.components)) walk(testCase.components[name], node => nodes.push(node));
  return nodes;
}

// --- Instance sampling -------------------------------------------------------

const JUNK = [null, true, false, 0, 1, -3, 2.5, 7, '', 'a', 'bb', 'eeeee', 'zzzzzzz', [], ['a'], [1, 'a'], {}, { id: 1 }, { title: 'a', description: 2 }];

function sample(rng, rawSchema, components, depth = 4) {
  const schema = deref(rawSchema, components);
  if (!isObject(schema) || depth < 0) return rng.pick(JUNK);
  if (rng.chance(0.05)) return rng.pick(JUNK);
  if (schema.allOf && rng.chance(0.9)) {
    const parts = [schema, ...schema.allOf].map(part => (part === schema
      ? sample(rng, { ...schema, allOf: undefined, anyOf: undefined, oneOf: undefined }, components, depth - 1)
      : sample(rng, part, components, depth - 1)));
    return parts.every(isObject) ? Object.assign({}, ...parts) : rng.pick(parts);
  }
  for (const keyword of ['anyOf', 'oneOf']) {
    if (schema[keyword]?.length && rng.chance(0.9)) return sample(rng, rng.pick(schema[keyword]), components, depth - 1);
  }
  if (schema.enum && rng.chance(0.8)) return rng.pick(schema.enum);
  if (schema.nullable === true && rng.chance(0.2)) return null;
  const type = Array.isArray(schema.type) ? rng.pick(schema.type) : schema.type;
  switch (type) {
    case 'string': {
      const length = rng.int((schema.minLength ?? 0) - 1, (schema.maxLength ?? 4) + 1);
      return 'x'.repeat(Math.max(0, length));
    }
    case 'integer': return rng.int((schema.minimum ?? -2) - 1, (schema.maximum ?? 4) + 1);
    case 'number': return rng.int((schema.minimum ?? -2) - 1, (schema.maximum ?? 4) + 1) + (rng.chance(0.3) ? 0.5 : 0);
    case 'boolean': return rng.chance(0.5);
    case 'array': {
      const length = Math.max(0, rng.int((schema.minItems ?? 0) - 1, (schema.maxItems ?? 2) + 1));
      return Array.from({ length }, () => (schema.items === undefined ? rng.pick(JUNK) : sample(rng, schema.items, components, depth - 1)));
    }
    case 'object': {
      const value = {};
      const required = new Set(schema.required ?? []);
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        if (required.has(name) ? rng.chance(0.95) : rng.chance(0.6)) value[name] = sample(rng, property, components, depth - 1);
      }
      for (const name of required) {
        if (!Object.hasOwn(value, name) && rng.chance(0.9)) value[name] = rng.pick(JUNK);
      }
      if (rng.chance(0.4)) {
        const name = rng.pick([...PROPERTY_NAMES, 'extra']);
        if (!Object.hasOwn(value, name)) {
          value[name] = isObject(schema.additionalProperties) && rng.chance(0.7)
            ? sample(rng, schema.additionalProperties, components, depth - 1)
            : rng.pick(JUNK);
        }
      }
      return value;
    }
    default: return rng.pick(JUNK);
  }
}

/** Instances drawn from both sides, so witnesses near either boundary turn up. */
function instances(rng, oldCase, newCase, count) {
  const values = [...JUNK];
  for (let i = 0; i < count; i++) {
    values.push(sample(rng, oldCase.schema, oldCase.components));
    values.push(sample(rng, newCase.schema, newCase.components));
  }
  return values;
}

// --- Mutations ---------------------------------------------------------------

// Each returns true when it changed the node. Declaring a new property is left
// out on purpose: the engine treats additive fields as compatible, in requests
// (an undeclared field was accepted without a contract) and in responses
// (clients are expected to ignore fields they do not know). For the same reason
// a closed object is never reopened.
const MUTATIONS = [
  function changeType(rng, node) {
    if (typeof node.type !== 'string') return false;
    node.type = rng.pick([...SCALAR_TYPES, 'object', 'array'].filter(type => type !== node.type));
    return true;
  },
  function toggleNullable(rng, node) {
    if (typeof node.type !== 'string') return false;
    if (node.nullable) delete node.nullable;
    else node.nullable = true;
    return true;
  },
  function dropType(rng, node) {
    if (node.type === undefined) return false;
    delete node.type;
    delete node.nullable;
    return true;
  },
  function addRequired(rng, node) {
    if (node.type !== 'object' && !node.properties) return false;
    const name = rng.pick([...Object.keys(node.properties ?? {}), rng.pick(PROPERTY_NAMES)]);
    if ((node.required ?? []).includes(name)) return false;
    node.required = [...(node.required ?? []), name];
    return true;
  },
  function removeRequired(rng, node) {
    if (!node.required?.length) return false;
    const name = rng.pick(node.required);
    node.required = node.required.filter(item => item !== name);
    if (node.required.length === 0) delete node.required;
    return true;
  },
  function removeProperty(rng, node) {
    const names = Object.keys(node.properties ?? {});
    if (names.length === 0) return false;
    delete node.properties[rng.pick(names)];
    return true;
  },
  function changeEnum(rng, node) {
    if (!node.enum) {
      if (node.type !== 'string' || !rng.chance(0.5)) return false;
      node.enum = ['a', 'bb'];
      return true;
    }
    const roll = rng.next();
    if (roll < 0.35 && node.enum.length > 1) node.enum = node.enum.slice(1);
    else if (roll < 0.7) node.enum = [...node.enum, rng.pick(['zz', 9, 'ccc', 0])];
    else delete node.enum;
    return true;
  },
  function shiftBound(rng, node) {
    const keyword = rng.pick(['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
    const applies = { minimum: ['integer', 'number'], maximum: ['integer', 'number'], minLength: ['string'], maxLength: ['string'], minItems: ['array'], maxItems: ['array'] }[keyword];
    if (node.type !== undefined && !applies.includes(node.type)) return false;
    if (node[keyword] === undefined) node[keyword] = keyword.startsWith('min') ? 1 : 3;
    else if (rng.chance(0.2)) delete node[keyword];
    else node[keyword] += rng.pick([-1, 1]);
    if (node[keyword] !== undefined && node[keyword] < 0 && !keyword.endsWith('imum')) node[keyword] = 0;
    return true;
  },
  function changeBranches(rng, node) {
    const keyword = rng.pick(['anyOf', 'oneOf', 'allOf']);
    if (!node[keyword]) return false;
    const roll = rng.next();
    if (roll < 0.4 && node[keyword].length > 1) node[keyword] = node[keyword].slice(0, -1);
    else if (roll < 0.8) node[keyword] = [...node[keyword], scalar(rng)];
    else node[keyword] = rng.shuffle(node[keyword]).slice(0, Math.max(1, node[keyword].length - 1)).concat([scalar(rng)]);
    return true;
  },
  function changeExtras(rng, node) {
    if (node.type !== 'object' || node.additionalProperties === false) return false;
    const roll = rng.next();
    if (roll < 0.3) node.additionalProperties = false;
    else if (roll < 0.8) node.additionalProperties = scalar(rng);
    else if (node.additionalProperties !== undefined) delete node.additionalProperties;
    else return false;
    return true;
  },
  function changeItems(rng, node) {
    if (node.type !== 'array') return false;
    node.items = scalar(rng);
    return true;
  },
];

function mutate(rng, original) {
  const mutated = structuredClone(original);
  const nodes = nodesOf(mutated);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (rng.pick(MUTATIONS)(rng, rng.pick(nodes))) return mutated;
  }
  return mutated;
}

// --- Meaning-preserving rewrites --------------------------------------------

function shuffleKeys(rng, object) {
  const copy = {};
  for (const key of rng.shuffle(Object.keys(object))) copy[key] = object[key];
  return copy;
}

/** Rewrites every schema without changing what it accepts. */
function respell(rng, rawSchema) {
  if (!isObject(rawSchema)) return rawSchema;
  if (typeof rawSchema.$ref === 'string') return { ...rawSchema };
  let schema = { ...rawSchema };
  if (schema.properties) {
    schema.properties = shuffleKeys(rng, Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [name, respell(rng, value)])));
  }
  if (isObject(schema.items)) schema.items = respell(rng, schema.items);
  if (isObject(schema.additionalProperties)) schema.additionalProperties = respell(rng, schema.additionalProperties);
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[keyword]) schema[keyword] = rng.shuffle(schema[keyword].map(branch => respell(rng, branch)));
  }
  if (schema.required) schema.required = rng.shuffle(schema.required);
  if (schema.enum) schema.enum = rng.shuffle(schema.enum);
  for (const keyword of ['title', 'description', 'default', 'example', 'examples', 'deprecated']) {
    const roll = rng.next();
    if (roll < 0.2) delete schema[keyword];
    else if (roll < 0.4) schema[keyword] = keyword === 'deprecated' ? rng.chance(0.5) : rng.pick(['changed', { title: 1 }, [1]]);
  }
  if (schema.type === 'string' && schema.minLength === undefined && rng.chance(0.3)) schema.minLength = 0;
  if (schema.type === 'array' && schema.minItems === undefined && rng.chance(0.3)) schema.minItems = 0;
  schema = shuffleKeys(rng, schema);
  return schema;
}

/** Moves some subschemas behind a new `$ref`, or inlines an existing one. */
function respellCase(rng, original) {
  const result = {
    schema: respell(rng, original.schema),
    components: Object.fromEntries(Object.entries(original.components).map(([name, value]) => [name, respell(rng, value)])),
  };
  let counter = 0;
  const extract = schema => {
    if (!isObject(schema) || typeof schema.$ref === 'string') return schema;
    for (const name of Object.keys(schema.properties ?? {})) schema.properties[name] = extract(schema.properties[name]);
    if (isObject(schema.items)) schema.items = extract(schema.items);
    for (const keyword of ['anyOf', 'oneOf']) {
      if (schema[keyword]) schema[keyword] = schema[keyword].map(extract);
    }
    if (!rng.chance(0.2)) return schema;
    const name = `Extracted${counter++}`;
    result.components[name] = schema;
    return { $ref: `#/components/schemas/${name}` };
  };
  result.schema = extract(result.schema);
  return result;
}

// --- Running a comparison ----------------------------------------------------

const PLACEMENTS = {
  requestBody: (spec, schema) => { spec.paths['/things'].post.requestBody = { content: { 'application/json': { schema } } }; },
  parameter: (spec, schema) => { spec.paths['/things'].post.parameters = [{ name: 'filter', in: 'query', schema }]; },
  responseBody: (spec, schema) => { spec.paths['/things'].post.responses['200'].content = { 'application/json': { schema } }; },
  responseHeader: (spec, schema) => { spec.paths['/things'].post.responses['200'].headers = { 'X-Meta': { schema } }; },
};
const REQUEST_PLACEMENTS = ['requestBody', 'parameter'];
const RESPONSE_PLACEMENTS = ['responseBody', 'responseHeader'];

function specification(placement, testCase) {
  const spec = {
    openapi: '3.0.3',
    paths: { '/things': { post: { responses: { '200': { description: 'OK' } } } } },
    components: { schemas: structuredClone(testCase.components) },
  };
  PLACEMENTS[placement](spec, structuredClone(testCase.schema));
  return spec;
}

function findings(placement, oldCase, newCase) {
  const result = compareSpecifications(specification(placement, oldCase), specification(placement, newCase));
  return [...result.breaking, ...result.notices];
}

function canonicalOf(testCase) {
  return canonicalize(documentFor({ components: { schemas: testCase.components } }), testCase.schema);
}

const describeCase = (seed, oldCase, newCase) =>
  `seed ${seed}\nold: ${JSON.stringify(oldCase)}\nnew: ${JSON.stringify(newCase)}`;

// --- Properties --------------------------------------------------------------

const RUNS = 400;

test('the reference validator and sampler agree on generated schemas', () => {
  // Guards the oracle itself: sampling must regularly hit valid instances,
  // otherwise the witness search below would prove nothing.
  let hits = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const rng = generator(seed);
    const testCase = generateCase(rng);
    for (let i = 0; i < 20; i++) {
      if (valid(testCase.schema, sample(rng, testCase.schema, testCase.components), testCase.components)) {
        hits++;
        break;
      }
    }
  }
  assert.ok(hits > 150, `only ${hits} of 200 schemas produced a valid sample`);
});

test('respelling a schema changes neither its canonical form nor the findings', () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const rng = generator(seed);
    const original = generateCase(rng);
    const respelled = respellCase(rng, original);
    const context = describeCase(seed, original, respelled);

    assert.equal(canonicalOf(respelled), canonicalOf(original), `canonical forms differ\n${context}`);
    for (const placement of Object.keys(PLACEMENTS)) {
      assert.deepEqual(findings(placement, original, respelled), [], `${placement} forward\n${context}`);
      assert.deepEqual(findings(placement, respelled, original), [], `${placement} backward\n${context}`);
    }
  }
});

test('respelling either side of a change leaves the findings untouched', () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const rng = generator(seed + 10000);
    const original = generateCase(rng);
    const changed = mutate(rng, original);
    // Key order and annotations only: extracting a `$ref` would legitimately
    // move a finding's wording, which is not what this property is about.
    const respellOnly = testCase => ({
      schema: respell(rng, testCase.schema),
      components: Object.fromEntries(Object.entries(testCase.components).map(([name, value]) => [name, respell(rng, value)])),
    });
    const originalAgain = respellOnly(original);
    const changedAgain = respellOnly(changed);
    for (const placement of Object.keys(PLACEMENTS)) {
      const codes = list => list.map(f => `${f.code} ${f.location}`).sort();
      assert.deepEqual(
        codes(findings(placement, originalAgain, changedAgain)),
        codes(findings(placement, original, changed)),
        `${placement}\n${describeCase(seed + 10000, original, changed)}`,
      );
    }
  }
});

test('schemas with the same canonical form accept the same instances', () => {
  let equal = 0;
  for (let seed = 1; seed <= RUNS * 3; seed++) {
    const rng = generator(seed + 20000);
    const original = generateCase(rng);
    const other = rng.chance(0.5) ? mutate(rng, original) : respellCase(rng, mutate(rng, original));
    const left = canonicalOf(original);
    const right = canonicalOf(other);
    assert.notEqual(left, null);
    if (left !== right) continue;
    equal++;
    for (const value of instances(rng, original, other, 40)) {
      assert.equal(
        valid(other.schema, value, other.components),
        valid(original.schema, value, original.components),
        `canonical forms are equal but ${JSON.stringify(value)} tells the schemas apart\n${describeCase(seed + 20000, original, other)}`,
      );
    }
  }
  assert.ok(equal > 0, 'no pair with equal canonical forms was generated');
});

test('a change that an instance proves incompatible is never passed over in silence', () => {
  let requestWitnesses = 0;
  let responseWitnesses = 0;
  for (let seed = 1; seed <= RUNS * 3; seed++) {
    const rng = generator(seed + 30000);
    const original = generateCase(rng);
    let changed = mutate(rng, original);
    if (rng.chance(0.3)) changed = mutate(rng, changed);
    const context = describeCase(seed + 30000, original, changed);

    let rejected;
    let introduced;
    for (const value of instances(rng, original, changed, 60)) {
      const before = valid(original.schema, value, original.components);
      const after = valid(changed.schema, value, changed.components);
      if (before && !after && rejected === undefined) rejected = value;
      if (!before && after && introduced === undefined) introduced = value;
    }

    if (rejected !== undefined) {
      requestWitnesses++;
      for (const placement of REQUEST_PLACEMENTS) {
        assert.notEqual(findings(placement, original, changed).length, 0,
          `${placement}: ${JSON.stringify(rejected)} was accepted and is now rejected, but nothing was reported\n${context}`);
      }
    }
    if (introduced !== undefined) {
      responseWitnesses++;
      for (const placement of RESPONSE_PLACEMENTS) {
        assert.notEqual(findings(placement, original, changed).length, 0,
          `${placement}: ${JSON.stringify(introduced)} can now be returned and could not before, but nothing was reported\n${context}`);
      }
    }
  }
  // The property is only worth something if witnesses are actually found.
  assert.ok(requestWitnesses > RUNS / 2, `only ${requestWitnesses} request witnesses`);
  assert.ok(responseWitnesses > RUNS / 2, `only ${responseWitnesses} response witnesses`);
});

test('comparison results are reproducible for the same inputs', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rng = generator(seed + 40000);
    const original = generateCase(rng);
    const changed = mutate(rng, original);
    for (const placement of Object.keys(PLACEMENTS)) {
      const first = compareSpecifications(specification(placement, original), specification(placement, changed));
      const second = compareSpecifications(specification(placement, original), specification(placement, changed));
      assert.deepEqual(second, first, `${placement} seed ${seed + 40000}`);
    }
  }
});
