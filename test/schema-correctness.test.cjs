const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareSpecifications } = require('../.build/comparator.js');
const { canonicalize, documentFor } = require('../.build/schema.js');

// Every place a schema is compared. A rule that holds for one of them has to
// hold for all of them, so most tests below run against the whole list.
const LOCATIONS = {
  requestBody: {
    direction: 'request',
    place: (spec, schema) => {
      spec.paths['/things'].post.requestBody = { content: { 'application/json': { schema } } };
    },
  },
  parameter: {
    direction: 'request',
    place: (spec, schema) => {
      spec.paths['/things'].post.parameters = [{ name: 'filter', in: 'query', schema }];
    },
  },
  responseBody: {
    direction: 'response',
    place: (spec, schema) => {
      spec.paths['/things'].post.responses['200'].content = { 'application/json': { schema } };
    },
  },
  errorResponseBody: {
    direction: 'response',
    place: (spec, schema) => {
      spec.paths['/things'].post.responses['4XX'] = {
        description: 'Error', content: { 'application/problem+json': { schema } },
      };
    },
  },
  responseHeader: {
    direction: 'response',
    place: (spec, schema) => {
      spec.paths['/things'].post.responses['200'].headers = { 'X-Meta': { schema } };
    },
  },
  responseHeaderContent: {
    direction: 'response',
    place: (spec, schema) => {
      spec.paths['/things'].post.responses['200'].headers = {
        'X-Meta': { content: { 'application/json': { schema } } },
      };
    },
  },
};

const LOCATION_NAMES = Object.keys(LOCATIONS);
const REQUEST_LOCATIONS = LOCATION_NAMES.filter(name => LOCATIONS[name].direction === 'request');
const RESPONSE_LOCATIONS = LOCATION_NAMES.filter(name => LOCATIONS[name].direction === 'response');

function document(location, schema, { version = '3.0.3', components } = {}) {
  const spec = {
    openapi: version,
    paths: { '/things': { post: { responses: { '200': { description: 'OK' } } } } },
  };
  if (components) spec.components = { schemas: structuredClone(components) };
  LOCATIONS[location].place(spec, structuredClone(schema));
  return spec;
}

/** Compares two schemas placed at `location`. Options may differ per side. */
function compareAt(location, oldSchema, newSchema, options = {}) {
  const { version, oldComponents, newComponents, components } = options;
  return compareSpecifications(
    document(location, oldSchema, { version, components: oldComponents ?? components }),
    document(location, newSchema, { version, components: newComponents ?? components }),
  );
}

const findingCodes = result => [...result.breaking, ...result.notices].map(f => f.code);

function assertSilent(result, label) {
  assert.deepEqual(result.breaking, [], `${label}: unexpected breaking findings`);
  assert.deepEqual(result.notices, [], `${label}: unexpected notices`);
}

function assertFlagged(result, label) {
  assert.ok(result.breaking.length + result.notices.length > 0,
    `${label}: the change produced no finding at all`);
}

function assertReviewOnly(result, code, label) {
  assert.deepEqual(result.breaking, [], `${label}: a verdict was reached without proof`);
  assert.ok(result.notices.some(f => f.code === code),
    `${label}: expected a ${code} notice, got ${JSON.stringify(findingCodes(result))}`);
}

function canonical(schema, components) {
  const root = { components: { schemas: components ?? {} } };
  return canonicalize(documentFor(root), schema);
}

// =============================================================================
// Known false negative: properties named like annotations
// =============================================================================

const ANNOTATION_NAMES = [
  'title', 'description', 'default', 'example', 'examples',
  'summary', 'deprecated', 'externalDocs', 'xml', 'discriminator',
  '$comment', '$id', '$schema', '$anchor',
];

for (const keyword of ['anyOf', 'oneOf']) {
  for (const name of ANNOTATION_NAMES) {
    test(`a property named \`${name}\` changing type inside ${keyword} is reported everywhere`, () => {
      const branch = type => ({ type: 'object', properties: { [name]: { type } } });
      for (const location of LOCATION_NAMES) {
        const result = compareAt(location,
          { [keyword]: [branch('string'), { type: 'integer' }] },
          { [keyword]: [branch('integer'), { type: 'integer' }] });
        assertReviewOnly(result, 'UNSUPPORTED_COMPOSITION', `${location} ${keyword} ${name}`);
      }
    });
  }
}

test('a property named like an annotation is distinguished at any nesting depth', () => {
  const nested = type => ({
    anyOf: [{
      type: 'object',
      properties: {
        outer: {
          type: 'array',
          items: { type: 'object', properties: { description: { type: 'object', properties: { title: { type } } } } },
        },
      },
    }],
  });
  for (const location of LOCATION_NAMES) {
    assertFlagged(compareAt(location, nested('string'), nested('boolean')), location);
  }
});

test('an annotation-named property is not lost in an unmergeable allOf', () => {
  // The two `pattern`s make the composition unmergeable, so whether it changed
  // is decided by canonical equality alone.
  const composed = type => ({
    allOf: [
      { pattern: '^a', properties: { title: { type } } },
      { pattern: 'z$' },
    ],
  });
  for (const location of LOCATION_NAMES) {
    assertReviewOnly(compareAt(location, composed('string'), composed('integer')),
      'UNSUPPORTED_COMPOSITION', location);
  }
});

test('annotation-named keys are kept in every map of subschemas', () => {
  for (const map of ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']) {
    for (const name of ['title', 'description', 'default', 'example', 'examples']) {
      assert.notEqual(
        canonical({ [map]: { [name]: { type: 'string' } } }),
        canonical({ [map]: { [name]: { type: 'integer' } } }),
        `${map}.${name}`,
      );
      assert.notEqual(
        canonical({ [map]: { [name]: { type: 'string' } } }),
        canonical({ [map]: {} }),
        `${map}.${name} removed`,
      );
    }
  }
});

test('adding or removing an annotation-named property inside a union is a change', () => {
  for (const name of ['title', 'description', 'default', 'example', 'examples']) {
    const result = compareAt('requestBody',
      { oneOf: [{ type: 'object', properties: { id: { type: 'string' } } }] },
      { oneOf: [{ type: 'object', properties: { id: { type: 'string' }, [name]: { type: 'string' } } }] });
    assertReviewOnly(result, 'UNSUPPORTED_COMPOSITION', name);
  }
});

test('annotation-named properties are compared directly outside compositions', () => {
  for (const name of ['title', 'description', 'default', 'example', 'examples']) {
    const shape = type => ({ type: 'object', properties: { [name]: { type } } });
    const request = compareAt('requestBody', shape('string'), shape('integer'));
    assert.deepEqual(request.breaking.map(f => f.code), ['SCHEMA_TYPE_CHANGED'], name);
    assert.ok(request.breaking[0].location.endsWith(`.${name}`), name);
    const response = compareAt('responseBody', shape('string'), shape('integer'));
    assert.deepEqual(response.breaking.map(f => f.code), ['SCHEMA_TYPE_CHANGED'], name);
  }
});

// =============================================================================
// Annotations are still ignored where they are annotations
// =============================================================================

test('schema annotations changing inside a union are not a change', () => {
  const branch = annotations => ({
    type: 'object',
    ...annotations,
    properties: { id: { type: 'string', ...annotations } },
  });
  const before = { title: 'Old', description: 'old', default: { id: 'a' }, example: { id: 'a' }, examples: [{ id: 'a' }], deprecated: false };
  const after = { title: 'New', description: 'new', default: { id: 'b' }, example: { id: 'b' }, examples: [{ id: 'b' }], deprecated: true };
  for (const keyword of ['anyOf', 'oneOf']) {
    for (const location of LOCATION_NAMES) {
      assertSilent(compareAt(location,
        { [keyword]: [branch(before), { type: 'integer' }] },
        { [keyword]: [branch(after), { type: 'integer' }] }), `${location} ${keyword}`);
    }
  }
});

test('an annotation keyword and a property of the same name are told apart in one schema', () => {
  // `title` is prose on the schema and a field under `properties`.
  const shape = (prose, type) => ({
    oneOf: [{ title: prose, type: 'object', properties: { title: { title: prose, type } } }],
  });
  assertSilent(compareAt('requestBody', shape('one', 'string'), shape('two', 'string')), 'prose only');
  assertReviewOnly(compareAt('requestBody', shape('one', 'string'), shape('one', 'integer')),
    'UNSUPPORTED_COMPOSITION', 'field type');
});

test('annotation-named keys inside enum and const values are data', () => {
  const variants = [
    [{ enum: [{ title: 'a' }] }, { enum: [{ title: 'b' }] }],
    [{ enum: [{ description: 'a', id: 1 }] }, { enum: [{ id: 1 }] }],
    [{ const: { default: 1 } }, { const: { default: 2 } }],
    [{ const: { examples: [1] } }, { const: {} }],
  ];
  for (const [before, after] of variants) {
    assert.notEqual(canonical(before), canonical(after), JSON.stringify(before));
    assertFlagged(compareAt('requestBody', { anyOf: [before] }, { anyOf: [after] }), JSON.stringify(before));
  }
  const constChange = compareAt('requestBody',
    { type: 'object', const: { title: 'a' } }, { type: 'object', const: { title: 'b' } });
  assertReviewOnly(constChange, 'CONSTRAINT_NOT_COMPARED', 'const');
});

test('a `$ref` inside enum data is a value, not a reference', () => {
  const components = { A: { type: 'string' } };
  assert.notEqual(
    canonical({ enum: [{ $ref: '#/components/schemas/A' }] }, components),
    canonical({ enum: [{ type: 'string' }] }, components),
  );
  // And it must not be reported as unresolvable or fail.
  assert.equal(typeof canonical({ enum: [{ $ref: '#/nowhere' }] }), 'string');
});

test('a property named `$ref` is a property', () => {
  const shape = type => ({ anyOf: [{ type: 'object', properties: { $ref: { type } } }] });
  assertFlagged(compareAt('responseBody', shape('string'), shape('integer')), '$ref property');
  const direct = compareAt('responseBody',
    { type: 'object', properties: { $ref: { type: 'string' } } },
    { type: 'object', properties: { $ref: { type: 'integer' } } });
  assert.deepEqual(direct.breaking.map(f => f.code), ['SCHEMA_TYPE_CHANGED']);
});

// =============================================================================
// Equivalent spellings produce no findings
// =============================================================================

const EQUIVALENT_PAIRS = {
  'reordered object keys': [
    { anyOf: [{ type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] }] },
    { anyOf: [{ required: ['a'], properties: { b: { type: 'integer' }, a: { type: 'string' } }, type: 'object' }] },
  ],
  'reordered required': [
    { oneOf: [{ type: 'object', required: ['a', 'b'] }, { type: 'string' }] },
    { oneOf: [{ type: 'object', required: ['b', 'a'] }, { type: 'string' }] },
  ],
  'reordered enum': [
    { oneOf: [{ type: 'string', enum: ['x', 'y', 'z'] }, { type: 'integer' }] },
    { oneOf: [{ type: 'string', enum: ['z', 'x', 'y'] }, { type: 'integer' }] },
  ],
  'reordered nested alternatives': [
    { oneOf: [{ type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'integer' }] } } }, { type: 'boolean' }] },
    { oneOf: [{ type: 'boolean' }, { type: 'object', properties: { v: { anyOf: [{ type: 'integer' }, { type: 'string' }] } } }] },
  ],
  'reordered allOf inside a union': [
    { anyOf: [{ allOf: [{ pattern: '^a' }, { pattern: 'z$' }] }] },
    { anyOf: [{ allOf: [{ pattern: 'z$' }, { pattern: '^a' }] }] },
  ],
  'reordered unmergeable allOf': [
    { allOf: [{ pattern: '^a', properties: { title: { type: 'string' } } }, { pattern: 'z$' }] },
    { allOf: [{ pattern: 'z$' }, { properties: { title: { type: 'string' } }, pattern: '^a' }] },
  ],
  'repeated anyOf alternative': [
    { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'string' }] },
  ],
  'type as string or one-element list': [
    { anyOf: [{ type: 'string' }, { type: 'object', properties: { n: { type: 'integer' } } }] },
    { anyOf: [{ type: ['string'] }, { type: 'object', properties: { n: { type: ['integer'] } } }] },
  ],
  'defaults written out': [
    { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    { oneOf: [{ type: 'string', minLength: 0 }, { type: 'array', items: { type: 'string' }, minItems: 0, uniqueItems: false, required: [] }] },
  ],
};

for (const [name, [before, after]] of Object.entries(EQUIVALENT_PAIRS)) {
  test(`equivalent schemas are silent everywhere: ${name}`, () => {
    for (const location of LOCATION_NAMES) {
      assertSilent(compareAt(location, before, after), `${location} forward`);
      assertSilent(compareAt(location, after, before), `${location} backward`);
    }
  });
}

test('nullable and a "null" type are the same alternative', () => {
  assert.equal(
    canonical({ type: 'string', nullable: true }),
    canonical({ type: ['null', 'string'] }),
  );
  assert.equal(canonical({ type: ['integer', 'number'] }), canonical({ type: 'number' }));
  assert.notEqual(canonical({ type: 'string', nullable: true }), canonical({ type: 'string' }));
  assert.notEqual(canonical({ type: 'integer' }), canonical({ type: 'number' }));
});

test('a repeated oneOf alternative is a change, because it can never match alone', () => {
  const result = compareAt('requestBody',
    { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    { oneOf: [{ type: 'string' }, { type: 'integer' }, { type: 'string' }] });
  assertReviewOnly(result, 'UNSUPPORTED_COMPOSITION', 'oneOf duplicate');
});

test('inlining or renaming a referenced alternative is not a change', () => {
  const pet = { type: 'object', required: ['name'], properties: { name: { type: 'string' }, title: { type: 'string' } } };
  for (const location of LOCATION_NAMES) {
    assertSilent(compareAt(location,
      { oneOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'string' }] },
      { oneOf: [{ type: 'string' }, pet] },
      { oldComponents: { Pet: pet }, newComponents: {} }), `${location} inlined`);
    assertSilent(compareAt(location,
      { oneOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'string' }] },
      { oneOf: [{ $ref: '#/components/schemas/Animal' }, { type: 'string' }] },
      { oldComponents: { Pet: pet }, newComponents: { Animal: { ...pet, description: 'renamed' } } }), `${location} renamed`);
  }
});

test('values that default differently are not folded together', () => {
  // None of these pairs accept the same instances.
  const pairs = [
    [{ minimum: 0 }, {}],
    [{ minContains: 0, contains: { type: 'string' } }, { contains: { type: 'string' } }],
    [{ required: ['a'] }, {}],
    [{ additionalProperties: false }, {}],
    [{ items: { type: 'string' } }, {}],
    [{ enum: ['a', 'b'] }, { enum: ['a'] }],
    [{ properties: { a: { type: 'string' } } }, { patternProperties: { a: { type: 'string' } } }],
    [{ prefixItems: [{ type: 'string' }, { type: 'integer' }] }, { prefixItems: [{ type: 'integer' }, { type: 'string' }] }],
    [{ anyOf: [{ type: 'string' }] }, { oneOf: [{ type: 'string' }] }],
  ];
  for (const [left, right] of pairs) {
    assert.notEqual(canonical(left), canonical(right), JSON.stringify(left));
  }
});

// =============================================================================
// Incompatible changes inside compositions are always surfaced
// =============================================================================

const BRANCH_CHANGES = {
  'required added': [
    { type: 'object', properties: { a: { type: 'string' } } },
    { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
  ],
  'enum value removed': [{ type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['a'] }],
  'bound moved': [{ type: 'integer', minimum: 1 }, { type: 'integer', minimum: 2 }],
  'nested bound moved': [
    { type: 'object', properties: { list: { type: 'array', items: { type: 'string', maxLength: 5 } } } },
    { type: 'object', properties: { list: { type: 'array', items: { type: 'string', maxLength: 4 } } } },
  ],
  'object closed': [
    { type: 'object', properties: { a: { type: 'string' } } },
    { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
  ],
  'additionalProperties schema changed': [
    { type: 'object', additionalProperties: { type: 'string' } },
    { type: 'object', additionalProperties: { type: 'integer' } },
  ],
  'pattern property changed': [
    { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
    { type: 'object', patternProperties: { '^x-': { type: 'integer' } } },
  ],
  'pattern key changed': [
    { type: 'object', patternProperties: { '^title$': { type: 'string' } } },
    { type: 'object', patternProperties: { '^description$': { type: 'string' } } },
  ],
  'nullable dropped': [{ type: 'string', nullable: true }, { type: 'string' }],
  'nested union changed': [
    { type: 'object', properties: { v: { oneOf: [{ type: 'string' }, { type: 'integer' }] } } },
    { type: 'object', properties: { v: { oneOf: [{ type: 'string' }, { type: 'boolean' }] } } },
  ],
};

for (const [name, [before, after]] of Object.entries(BRANCH_CHANGES)) {
  test(`a change inside a union branch is surfaced everywhere: ${name}`, () => {
    for (const keyword of ['anyOf', 'oneOf']) {
      for (const location of LOCATION_NAMES) {
        const result = compareAt(location,
          { [keyword]: [before, { type: 'boolean' }] },
          { [keyword]: [{ type: 'boolean' }, after] });
        assertReviewOnly(result, 'UNSUPPORTED_COMPOSITION', `${location} ${keyword}`);
      }
    }
  });
}

test('a referenced alternative whose target changed is a change', () => {
  const pet = type => ({ Pet: { type: 'object', properties: { description: { type } } } });
  for (const location of LOCATION_NAMES) {
    const result = compareAt(location,
      { oneOf: [{ $ref: '#/components/schemas/Pet' }] },
      { oneOf: [{ $ref: '#/components/schemas/Pet' }] },
      { oldComponents: pet('string'), newComponents: pet('integer') });
    assertReviewOnly(result, 'UNSUPPORTED_COMPOSITION', location);
  }
});

test('a change behind two levels of references inside a branch is a change', () => {
  const components = type => ({
    Outer: { type: 'object', properties: { inner: { $ref: '#/components/schemas/Inner' } } },
    Inner: { type: 'object', properties: { default: { type } } },
  });
  const schema = { anyOf: [{ type: 'array', items: { $ref: '#/components/schemas/Outer' } }] };
  for (const location of LOCATION_NAMES) {
    assertFlagged(compareAt(location, schema, schema,
      { oldComponents: components('string'), newComponents: components('number') }), location);
  }
});

// =============================================================================
// Uncompared keywords: change is judged on meaning, references included
// =============================================================================

const REFERENCING_KEYWORDS = {
  patternProperties: ref => ({ type: 'object', patternProperties: { '^x-': ref } }),
  propertyNames: ref => ({ type: 'object', propertyNames: ref }),
  dependentSchemas: ref => ({ type: 'object', dependentSchemas: { a: ref } }),
  contains: ref => ({ type: 'array', contains: ref }),
  not: ref => ({ not: ref }),
  if: ref => ({ if: ref, then: { type: 'string' } }),
  then: ref => ({ if: { type: 'string' }, then: ref }),
  else: ref => ({ if: { type: 'string' }, else: ref }),
  unevaluatedProperties: ref => ({ type: 'object', unevaluatedProperties: ref }),
  unevaluatedItems: ref => ({ type: 'array', unevaluatedItems: ref }),
};

for (const [keyword, build] of Object.entries(REFERENCING_KEYWORDS)) {
  test(`\`${keyword}\` pointing at a schema that changed is reported everywhere`, () => {
    const schema = build({ $ref: '#/components/schemas/Target' });
    for (const location of LOCATION_NAMES) {
      const changed = compareAt(location, schema, schema, {
        oldComponents: { Target: { type: 'string', maxLength: 5 } },
        newComponents: { Target: { type: 'string', maxLength: 4 } },
      });
      assertReviewOnly(changed, 'CONSTRAINT_NOT_COMPARED', `${location} ${keyword}`);
      assert.ok(changed.notices.some(f => f.message.includes(`\`${keyword}\` changed through a schema it references`)),
        `${location} ${keyword} message`);

      const unchanged = compareAt(location, schema, schema, {
        oldComponents: { Target: { type: 'string', maxLength: 5, description: 'old' } },
        newComponents: { Target: { maxLength: 5, type: 'string', description: 'new' } },
      });
      assertSilent(unchanged, `${location} ${keyword} unchanged`);
    }
  });
}

test('an uncompared keyword respelled without changing its meaning is silent', () => {
  for (const location of LOCATION_NAMES) {
    assertSilent(compareAt(location,
      { type: 'object', patternProperties: { '^a': { type: 'string', description: 'old' }, '^b': { type: 'integer' } } },
      { type: 'object', patternProperties: { '^b': { type: 'integer' }, '^a': { description: 'new', type: 'string' } } }),
    `${location} patternProperties`);
    assertSilent(compareAt(location,
      { type: 'object', dependentRequired: { a: ['b'] } },
      { dependentRequired: { a: ['b'] }, type: 'object' }), `${location} dependentRequired`);
    assertSilent(compareAt(location,
      { type: 'object' }, { type: 'object', minProperties: 0 }), `${location} minProperties`);
  }
});

test('a pattern property named like an annotation changing type is reported', () => {
  for (const name of ['title', 'description', 'default', 'example', 'examples']) {
    for (const location of LOCATION_NAMES) {
      assertReviewOnly(compareAt(location,
        { type: 'object', patternProperties: { [name]: { type: 'string' } } },
        { type: 'object', patternProperties: { [name]: { type: 'integer' } } }),
      'CONSTRAINT_NOT_COMPARED', `${location} ${name}`);
    }
  }
});

test('a discriminator change is reported for review', () => {
  const schema = mapping => ({
    oneOf: [{ $ref: '#/components/schemas/Cat' }, { $ref: '#/components/schemas/Dog' }],
    discriminator: { propertyName: 'kind', mapping },
  });
  const components = {
    Cat: { type: 'object', properties: { kind: { type: 'string' } } },
    Dog: { type: 'object', properties: { kind: { type: 'string' }, bark: { type: 'boolean' } } },
  };
  for (const location of LOCATION_NAMES) {
    const changed = compareAt(location,
      schema({ cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' }),
      schema({ cat: '#/components/schemas/Cat', puppy: '#/components/schemas/Dog' }), { components });
    assertReviewOnly(changed, 'CONSTRAINT_NOT_COMPARED', location);
    assert.ok(changed.notices.some(f => f.message.includes('`discriminator` changed')));
    assertSilent(compareAt(location,
      schema({ cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog' }),
      schema({ dog: '#/components/schemas/Dog', cat: '#/components/schemas/Cat' }), { components }),
    `${location} reordered mapping`);
  }
});

// =============================================================================
// additionalProperties
// =============================================================================

test('additionalProperties pointing at a schema that changed is reported everywhere', () => {
  const schema = { type: 'object', additionalProperties: { $ref: '#/components/schemas/Value' } };
  for (const location of LOCATION_NAMES) {
    const result = compareAt(location, schema, schema, {
      oldComponents: { Value: { type: 'string' } },
      newComponents: { Value: { type: 'integer' } },
    });
    assertReviewOnly(result, 'CONSTRAINT_NOT_COMPARED', location);
    assert.ok(result.notices.some(f => /additionalProperties` subschema changed/.test(f.message)));
  }
});

test('an additionalProperties subschema with a property named like an annotation', () => {
  const schema = type => ({
    type: 'object',
    additionalProperties: { type: 'object', properties: { title: { type } } },
  });
  for (const location of LOCATION_NAMES) {
    assertReviewOnly(compareAt(location, schema('string'), schema('integer')),
      'CONSTRAINT_NOT_COMPARED', location);
  }
});

test('a respelled additionalProperties subschema is silent', () => {
  for (const location of LOCATION_NAMES) {
    assertSilent(compareAt(location,
      { type: 'object', additionalProperties: { type: 'string', maxLength: 3, description: 'old' } },
      { type: 'object', additionalProperties: { maxLength: 3, type: 'string', title: 'New' } }), location);
    assertSilent(compareAt(location,
      { type: 'object', additionalProperties: { $ref: '#/components/schemas/Value' } },
      { type: 'object', additionalProperties: { type: 'string' } },
      { components: { Value: { type: 'string' } } }), `${location} inlined`);
  }
});

test('absent, true and an empty additionalProperties schema are the same', () => {
  const spellings = [
    { type: 'object' },
    { type: 'object', additionalProperties: true },
    { type: 'object', additionalProperties: {} },
    { type: 'object', additionalProperties: { description: 'anything' } },
  ];
  for (const before of spellings) {
    for (const after of spellings) {
      for (const location of LOCATION_NAMES) assertSilent(compareAt(location, before, after), location);
    }
  }
});

test('introducing an additionalProperties subschema on a request needs review', () => {
  for (const location of REQUEST_LOCATIONS) {
    for (const open of [{}, { additionalProperties: true }, { additionalProperties: {} }]) {
      const result = compareAt(location,
        { type: 'object', ...open },
        { type: 'object', additionalProperties: { type: 'string' } });
      assertReviewOnly(result, 'CONSTRAINT_NOT_COMPARED', location);
    }
    // The other way round only accepts more.
    assertSilent(compareAt(location,
      { type: 'object', additionalProperties: { type: 'string' } }, { type: 'object' }), `${location} relaxed`);
    assertSilent(compareAt(location,
      { type: 'object', additionalProperties: false },
      { type: 'object', additionalProperties: { type: 'string' } }), `${location} opened`);
  }
});

test('dropping an additionalProperties subschema on a response needs review', () => {
  for (const location of RESPONSE_LOCATIONS) {
    const result = compareAt(location,
      { type: 'object', additionalProperties: { type: 'string' } }, { type: 'object' });
    assertReviewOnly(result, 'CONSTRAINT_NOT_COMPARED', location);
    // The other way round only returns less.
    assertSilent(compareAt(location,
      { type: 'object' }, { type: 'object', additionalProperties: { type: 'string' } }), `${location} narrowed`);
    assertSilent(compareAt(location,
      { type: 'object', additionalProperties: { type: 'string' } },
      { type: 'object', additionalProperties: false }), `${location} closed`);
  }
});

test('closing a request object that had an additionalProperties subschema is breaking', () => {
  for (const location of REQUEST_LOCATIONS) {
    const result = compareAt(location,
      { type: 'object', additionalProperties: { type: 'string' } },
      { type: 'object', additionalProperties: false });
    assert.deepEqual(result.breaking.map(f => f.code), ['REQUEST_OBJECT_CLOSED'], location);
    assert.deepEqual(result.notices, [], location);
  }
});

test('a request field that falls back under an additionalProperties subschema needs review', () => {
  for (const location of REQUEST_LOCATIONS) {
    const result = compareAt(location,
      { type: 'object', properties: { count: { type: 'integer' } }, additionalProperties: { type: 'string' } },
      { type: 'object', additionalProperties: { type: 'string' } });
    assertReviewOnly(result, 'CONSTRAINT_NOT_COMPARED', location);
    assert.ok(result.notices.some(f => f.location.endsWith('.count')), location);
    // Removing a field from an open object accepts strictly more.
    assertSilent(compareAt(location,
      { type: 'object', properties: { count: { type: 'integer' } } }, { type: 'object' }), `${location} open`);
  }
});

test('additionalProperties is not reported on schemas that cannot be objects', () => {
  for (const location of LOCATION_NAMES) {
    assertSilent(compareAt(location,
      { type: 'string' }, { type: 'string', additionalProperties: { type: 'string' } }), location);
  }
});

// =============================================================================
// required without a matching property
// =============================================================================

test('a response guarantee on an undeclared property is still a guarantee', () => {
  for (const location of RESPONSE_LOCATIONS) {
    const result = compareAt(location,
      { type: 'object', required: ['id'] }, { type: 'object' });
    assert.deepEqual(result.breaking.map(f => f.code), ['RESPONSE_FIELD_OPTIONAL'], location);
    assert.ok(result.breaking[0].location.endsWith('.id'));
  }
  for (const location of REQUEST_LOCATIONS) {
    const result = compareAt(location, { type: 'object' }, { type: 'object', required: ['id'] });
    assert.deepEqual(result.breaking.map(f => f.code), ['REQUEST_FIELD_REQUIRED'], location);
  }
});

test('a removed required response field is reported once, as removed', () => {
  const result = compareAt('responseBody',
    { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    { type: 'object' });
  assert.deepEqual(result.breaking.map(f => f.code), ['RESPONSE_FIELD_REMOVED']);
});

test('a guarantee split between allOf branches is still read', () => {
  const result = compareAt('responseBody',
    { allOf: [{ type: 'object', properties: { id: { type: 'string' } } }, { required: ['id'] }] },
    { allOf: [{ type: 'object', properties: { id: { type: 'string' } } }] });
  assert.deepEqual(result.breaking.map(f => f.code), ['RESPONSE_FIELD_OPTIONAL']);
});

// =============================================================================
// Keywords beside $ref
// =============================================================================

test('OpenAPI 3.1: a constraint beside $ref is part of the schema', () => {
  const components = { Name: { type: 'string', maxLength: 50 } };
  const ref = extra => ({ type: 'object', properties: { name: { $ref: '#/components/schemas/Name', ...extra } } });
  for (const location of REQUEST_LOCATIONS) {
    const tightened = compareAt(location, ref({ maxLength: 20 }), ref({ maxLength: 10 }), { version: '3.1.0', components });
    assert.deepEqual(tightened.breaking.map(f => f.code), ['REQUEST_LENGTH_NARROWED'], location);
    const introduced = compareAt(location, ref({}), ref({ maxLength: 10 }), { version: '3.1.0', components });
    assert.deepEqual(introduced.breaking.map(f => f.code), ['REQUEST_LENGTH_NARROWED'], location);
    assertSilent(compareAt(location, ref({ maxLength: 10 }), ref({ maxLength: 20 }), { version: '3.1.0', components }), location);
    // A sibling looser than the target changes nothing: the target still applies.
    assertSilent(compareAt(location, ref({}), ref({ maxLength: 80 }), { version: '3.1.0', components }), `${location} looser`);
  }
  for (const location of RESPONSE_LOCATIONS) {
    const relaxed = compareAt(location, ref({ maxLength: 10 }), ref({ maxLength: 20 }), { version: '3.1.0', components });
    assert.deepEqual(relaxed.breaking.map(f => f.code), ['RESPONSE_LENGTH_WIDENED'], location);
    const dropped = compareAt(location, ref({ enum: ['a', 'b'] }), ref({}), { version: '3.1.0', components });
    assert.deepEqual(dropped.breaking.map(f => f.code), ['RESPONSE_ENUM_EXPANDED'], location);
  }
});

test('OpenAPI 3.1: a top-level $ref with siblings is compared as their intersection', () => {
  const components = { Base: { type: 'object', properties: { id: { type: 'string' } } } };
  const result = compareAt('requestBody',
    { $ref: '#/components/schemas/Base' },
    { $ref: '#/components/schemas/Base', required: ['id'] }, { version: '3.1.0', components });
  assert.deepEqual(result.breaking.map(f => f.code), ['REQUEST_FIELD_REQUIRED']);

  const nullable = compareAt('responseBody',
    { $ref: '#/components/schemas/Base' },
    { $ref: '#/components/schemas/Base', description: 'Only prose', title: 'Base', deprecated: true },
    { version: '3.1.0', components });
  assertSilent(nullable, 'annotations beside $ref');
});

test('OpenAPI 3.1: siblings beside a $ref that cannot be merged are reported, not dropped', () => {
  const components = { Code: { type: 'string', pattern: '^[A-Z]+$' } };
  const ref = pattern => ({ $ref: '#/components/schemas/Code', pattern });
  for (const location of LOCATION_NAMES) {
    assertReviewOnly(compareAt(location, ref('^A'), ref('^B'), { version: '3.1.0', components }),
      'UNSUPPORTED_COMPOSITION', location);
    assertSilent(compareAt(location, ref('^A'), ref('^A'), { version: '3.1.0', components }), location);
  }
});

test('OpenAPI 3.1: a sibling beside a $ref alias chain is not lost', () => {
  const components = {
    Alias: { $ref: '#/components/schemas/Name', minLength: 2 },
    Name: { type: 'string' },
  };
  const tightened = structuredClone(components);
  tightened.Alias.minLength = 3;
  const schema = { type: 'object', properties: { name: { $ref: '#/components/schemas/Alias' } } };
  const result = compareAt('requestBody', schema, schema,
    { version: '3.1.0', oldComponents: components, newComponents: tightened });
  assert.deepEqual(result.breaking.map(f => f.code), ['REQUEST_LENGTH_NARROWED']);
});

test('OpenAPI 3.1: a $ref with siblings that refers to itself terminates', () => {
  const components = { Loop: { $ref: '#/components/schemas/Loop', minLength: 1 } };
  const changed = { Loop: { $ref: '#/components/schemas/Loop', minLength: 2 } };
  const schema = { $ref: '#/components/schemas/Loop' };
  assertSilent(compareAt('requestBody', schema, schema, { version: '3.1.0', components }), 'unchanged');
  assertReviewOnly(compareAt('requestBody', schema, schema,
    { version: '3.1.0', oldComponents: components, newComponents: changed }), 'UNSUPPORTED_COMPOSITION', 'changed');
});

test('OpenAPI 3.0: keywords beside $ref are ignored, as the specification defines', () => {
  const components = { Name: { type: 'string', maxLength: 50 } };
  const ref = extra => ({ type: 'object', properties: { name: { $ref: '#/components/schemas/Name', ...extra } } });
  for (const location of LOCATION_NAMES) {
    assertSilent(compareAt(location, ref({ maxLength: 20 }), ref({ maxLength: 10 }), { version: '3.0.3', components }), location);
  }
});

test('siblings beside a $ref inside a union always count as a difference', () => {
  const components = { Name: { type: 'string' } };
  for (const version of ['3.0.3', '3.1.0']) {
    const result = compareAt('requestBody',
      { anyOf: [{ $ref: '#/components/schemas/Name', maxLength: 5 }] },
      { anyOf: [{ $ref: '#/components/schemas/Name', maxLength: 4 }] }, { version, components });
    assertReviewOnly(result, 'UNSUPPORTED_COMPOSITION', version);
  }
});

// =============================================================================
// allOf: keywords that depend on where they are written
// =============================================================================

const CONTEXTUAL_SPLITS = {
  'if and then in different branches': [
    { allOf: [{ if: { type: 'string' } }, { then: { minLength: 3 } }] },
    { if: { type: 'string' }, then: { minLength: 3 } },
  ],
  'contains and minContains in different branches': [
    { allOf: [{ type: 'array', contains: { type: 'string' } }, { minContains: 2 }] },
    { type: 'array', contains: { type: 'string' }, minContains: 2 },
  ],
  'prefixItems and items in different branches': [
    { allOf: [{ type: 'array', prefixItems: [{ type: 'integer' }] }, { items: { type: 'string' } }] },
    { type: 'array', prefixItems: [{ type: 'integer' }], items: { type: 'string' } },
  ],
  'unevaluatedProperties beside a branch that declares properties': [
    { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { unevaluatedProperties: false }] },
    { type: 'object', properties: { a: { type: 'string' } }, unevaluatedProperties: false },
  ],
  'unevaluatedItems beside a branch that declares items': [
    { allOf: [{ type: 'array', items: { type: 'string' } }, { unevaluatedItems: false }] },
    { type: 'array', items: { type: 'string' }, unevaluatedItems: false },
  ],
};

for (const [name, [split, joined]] of Object.entries(CONTEXTUAL_SPLITS)) {
  test(`allOf is not merged when it would change the meaning: ${name}`, () => {
    for (const location of LOCATION_NAMES) {
      assertFlagged(compareAt(location, split, joined, { version: '3.1.0' }), `${location} split → joined`);
      assertFlagged(compareAt(location, joined, split, { version: '3.1.0' }), `${location} joined → split`);
      assert.deepEqual(compareAt(location, split, joined, { version: '3.1.0' }).breaking, [], location);
      assertSilent(compareAt(location, split, split, { version: '3.1.0' }), `${location} unchanged`);
    }
  });
}

test('if/then/else kept together in one branch still merges', () => {
  const schema = minLength => ({
    allOf: [
      { type: 'string', minLength },
      { if: { pattern: '^a' }, then: { maxLength: 9 }, else: { maxLength: 5 } },
    ],
  });
  const result = compareAt('requestBody', schema(1), schema(2));
  assert.deepEqual(result.breaking.map(f => f.code), ['REQUEST_LENGTH_NARROWED']);
  assert.deepEqual(result.notices, []);
});

test('a `false` allOf branch is never read as an empty schema', () => {
  for (const location of LOCATION_NAMES) {
    assertFlagged(compareAt(location,
      { allOf: [{ type: 'string' }] }, { allOf: [{ type: 'string' }, false] }, { version: '3.1.0' }), location);
    assertSilent(compareAt(location,
      { allOf: [{ type: 'string' }] }, { allOf: [{ type: 'string' }, true] }, { version: '3.1.0' }), `${location} true`);
  }
});

// =============================================================================
// Boolean schemas and tuple items
// =============================================================================

test('a boolean subschema that changed is reported for review', () => {
  const shape = value => ({ type: 'object', properties: { extra: value } });
  for (const location of LOCATION_NAMES) {
    for (const [before, after] of [[true, false], [false, true], [{ type: 'string' }, false], [false, {}]]) {
      assertReviewOnly(compareAt(location, shape(before), shape(after), { version: '3.1.0' }),
        'SCHEMA_NOT_COMPARED', `${location} ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    }
    for (const [before, after] of [[true, true], [false, false], [true, {}], [{ description: 'any' }, true]]) {
      assertSilent(compareAt(location, shape(before), shape(after), { version: '3.1.0' }),
        `${location} ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    }
  }
});

test('boolean array items are not read as an empty schema', () => {
  for (const location of LOCATION_NAMES) {
    assertReviewOnly(compareAt(location,
      { type: 'array', items: true }, { type: 'array', items: false }, { version: '3.1.0' }),
    'SCHEMA_NOT_COMPARED', location);
  }
});

test('positional items in the array form are reported as tuple validation', () => {
  for (const location of LOCATION_NAMES) {
    const result = compareAt(location,
      { type: 'array', items: [{ type: 'string' }] }, { type: 'array', items: [{ type: 'integer' }] });
    assertReviewOnly(result, 'UNSUPPORTED_TUPLE_ITEMS', location);
  }
});

// =============================================================================
// Recursive references
// =============================================================================

const tree = valueType => ({
  Node: {
    type: 'object',
    properties: {
      title: { type: valueType },
      children: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
    },
  },
});

test('an unchanged recursive schema inside a union is silent', () => {
  const schema = { oneOf: [{ $ref: '#/components/schemas/Node' }, { type: 'string' }] };
  for (const location of LOCATION_NAMES) {
    assertSilent(compareAt(location, schema, schema, { components: tree('string') }), location);
  }
});

test('a change inside a recursive schema is found through the union', () => {
  const schema = { oneOf: [{ $ref: '#/components/schemas/Node' }, { type: 'string' }] };
  for (const location of LOCATION_NAMES) {
    assertReviewOnly(compareAt(location, schema, schema,
      { oldComponents: tree('string'), newComponents: tree('integer') }), 'UNSUPPORTED_COMPOSITION', location);
  }
});

test('a change inside a directly compared recursive schema is found', () => {
  const schema = { $ref: '#/components/schemas/Node' };
  const request = compareAt('requestBody', schema, schema,
    { oldComponents: tree('string'), newComponents: tree('integer') });
  assert.deepEqual(request.breaking.map(f => f.code), ['SCHEMA_TYPE_CHANGED']);
});

test('recursions anchored at different depths are different schemas', () => {
  // Both spell the same nesting down to the cycle, but one recurses to the
  // root and the other to the value of `a`.
  const inner = {
    P: { type: 'object', properties: { a: { $ref: '#/components/schemas/Q' } } },
    Q: { type: 'object', properties: { b: { type: 'object', properties: { a: { $ref: '#/components/schemas/Q' } } } } },
  };
  const outer = {
    P: { $ref: '#/components/schemas/Q' },
    Q: { type: 'object', properties: { a: { type: 'object', properties: { b: { $ref: '#/components/schemas/Q' } } } } },
  };
  const left = canonical({ $ref: '#/components/schemas/P' }, inner);
  const right = canonical({ $ref: '#/components/schemas/P' }, outer);
  assert.notEqual(left, right);

  const sameSpine = {
    P: { type: 'object', properties: { a: { $ref: '#/components/schemas/Q' } } },
    Q: { type: 'object', properties: { b: { $ref: '#/components/schemas/Q' } } },
  };
  const shifted = {
    P: { $ref: '#/components/schemas/Q' },
    Q: { type: 'object', properties: { a: { type: 'object', properties: { b: { $ref: '#/components/schemas/Q' } } } } },
  };
  assert.notEqual(
    canonical({ $ref: '#/components/schemas/P' }, sameSpine),
    canonical({ $ref: '#/components/schemas/P' }, shifted),
  );
  const schema = { anyOf: [{ $ref: '#/components/schemas/P' }] };
  assertFlagged(compareAt('requestBody', schema, schema,
    { oldComponents: sameSpine, newComponents: shifted }), 'anchor moved');
});

test('mutually recursive schemas canonicalise and compare', () => {
  const components = type => ({
    A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
    B: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' }, description: { type } } },
  });
  const schema = { anyOf: [{ $ref: '#/components/schemas/A' }] };
  assertSilent(compareAt('responseBody', schema, schema, { components: components('string') }), 'unchanged');
  assertFlagged(compareAt('responseBody', schema, schema,
    { oldComponents: components('string'), newComponents: components('integer') }), 'changed');
});

// =============================================================================
// Conservative fallbacks and determinism
// =============================================================================

test('a union too large to canonicalise is reported, never assumed equal', () => {
  const wide = type => {
    const properties = {};
    for (let i = 0; i < 25000; i++) properties[`p${i}`] = { type: i === 24999 ? type : 'string' };
    return { oneOf: [{ type: 'object', properties }] };
  };
  const result = compareAt('requestBody', wide('string'), wide('integer'));
  assertReviewOnly(result, 'UNSUPPORTED_COMPOSITION', 'over budget');
  assert.ok(result.notices.some(f => /too large to compare/.test(f.message)));
  assert.equal(canonical(wide('string').oneOf[0]), null);
});

test('findings are identical from run to run and independent of key order', () => {
  const before = {
    type: 'object',
    required: ['a'],
    properties: {
      a: { oneOf: [{ type: 'object', properties: { title: { type: 'string' } } }] },
      b: { type: 'object', additionalProperties: { type: 'string' } },
      c: { type: 'string', maxLength: 5 },
    },
  };
  const after = {
    type: 'object',
    properties: {
      c: { maxLength: 4, type: 'string' },
      b: { additionalProperties: { type: 'integer' }, type: 'object' },
      a: { oneOf: [{ properties: { title: { type: 'integer' } }, type: 'object' }] },
    },
  };
  const reordered = {
    properties: { c: before.properties.c, a: before.properties.a, b: before.properties.b },
    required: ['a'],
    type: 'object',
  };
  for (const location of LOCATION_NAMES) {
    const first = compareAt(location, before, after);
    assert.deepEqual(compareAt(location, before, after), first, location);
    assert.deepEqual(compareAt(location, reordered, after), first, `${location} reordered`);
    assert.ok(first.breaking.length + first.notices.length >= 3, location);
  }
});

test('canonical forms do not depend on which document object is asked first', () => {
  const components = tree('string');
  const root = { components: { schemas: components } };
  const doc = documentFor(root);
  const viaRef = canonicalize(doc, { $ref: '#/components/schemas/Node' });
  const child = canonicalize(doc, components.Node.properties.children);
  const fresh = documentFor(structuredClone(root));
  assert.equal(canonicalize(fresh, components.Node.properties.children), child);
  assert.equal(canonicalize(fresh, { $ref: '#/components/schemas/Node' }), viaRef);
});
