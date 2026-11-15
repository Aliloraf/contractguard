import type { JsonObject } from './types';

/**
 * Keywords that carry no validation meaning. They are dropped when schemas are
 * merged or canonicalised, so two schemas that differ only in their prose are
 * treated as the same contract.
 *
 * This is a set of *keywords*, and only applies where a keyword can appear:
 * directly inside a schema object. The same strings are ordinary names when
 * they are keys of `properties` or of any other map, and ordinary data inside
 * `enum`, `const` and the like, where they must never be dropped.
 */
export const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  'title', 'description', 'summary', 'example', 'examples', 'default', 'deprecated',
  '$comment', '$id', '$schema', '$anchor', 'externalDocs', 'xml',
]);

/** Keywords whose value is a single subschema. */
export const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'items', 'additionalProperties', 'additionalItems', 'not', 'if', 'then', 'else',
  'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems', 'contentSchema',
]);

/** Keywords whose value is a list of subschemas. */
export const SUBSCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set([
  'allOf', 'anyOf', 'oneOf', 'prefixItems',
]);

/**
 * Keywords whose value is a map from an arbitrary name to a subschema. The keys
 * of these maps are property names, patterns or definition names chosen by the
 * API author, never schema keywords.
 */
export const SUBSCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions',
]);

export const NUMERIC_TYPES = ['number', 'integer'] as const;

/** The merged form of a composed schema, with whether the merge was lossless. */
export interface FlattenedSchema {
  schema: JsonObject;
  /** True when the merged schema accepts exactly what the original accepts. */
  exact: boolean;
  reason: string | null;
}

/**
 * One side of a comparison: a document root plus per-run memoisation. Caching by
 * schema identity matters for more than speed — it keeps merged schemas stable,
 * which is what lets the cycle guards in the comparator recognise a schema it
 * has already visited.
 */
export interface Document {
  readonly root: JsonObject;
  readonly flattened: WeakMap<JsonObject, FlattenedSchema>;
  readonly canonical: WeakMap<JsonObject, string>;
  /**
   * Whether keywords written beside a `$ref` constrain the instance. OpenAPI 3.0
   * and Swagger 2.0 define them as ignored; from OpenAPI 3.1 on a schema is a
   * JSON Schema 2020-12 schema, where they apply together with the target.
   */
  readonly refSiblingsApply: boolean;
  /** The `allOf` form of each `$ref` that has sibling keywords, by identity. */
  readonly refCompositions: WeakMap<JsonObject, JsonObject>;
}

export function documentFor(root: JsonObject): Document {
  const version = root.openapi;
  const ignoresSiblings = 'swagger' in root || (typeof version === 'string' && /^3\.0(\.|$)/.test(version));
  return {
    root,
    flattened: new WeakMap(),
    canonical: new WeakMap(),
    refSiblingsApply: !ignoresSiblings,
    refCompositions: new WeakMap(),
  };
}

export function record(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function valueKey(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

function pointerSegments(ref: string): string[] {
  return ref.slice(2).split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * One step of a JSON Pointer walk: an own property of an object, or a canonical
 * decimal index of an array. Anything else, including inherited names such as
 * `constructor`, is absent.
 */
export function childOf(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    return /^(0|[1-9][0-9]*)$/.test(key) ? value[Number(key)] : undefined;
  }
  if (value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key)) {
    return (value as JsonObject)[key];
  }
  return undefined;
}

/** The value an internal `#/...` pointer names, or `undefined` when nothing is there. */
export function lookupPointer(root: unknown, ref: string): unknown {
  let target: unknown = root;
  for (const key of pointerSegments(ref)) {
    target = childOf(target, key);
    if (target === undefined) return undefined;
  }
  return target;
}

/** Follows one internal reference. */
function dereference(root: JsonObject, ref: string): JsonObject {
  if (!ref.startsWith('#/')) {
    throw new Error(`Only internal OpenAPI references are supported: ${ref}`);
  }
  const target = lookupPointer(root, ref);
  if (target === undefined) throw new Error(`Unresolved OpenAPI reference: ${ref}`);
  return record(target);
}

export function resolve(root: JsonObject, value: unknown): JsonObject {
  let current = record(value);
  const seen = new Set<string>();
  while (typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (!ref.startsWith('#/')) {
      throw new Error(`Only internal OpenAPI references are supported: ${ref}`);
    }
    if (seen.has(ref)) {
      throw new Error(`Cyclic $ref alias: ${ref}`);
    }
    seen.add(ref);
    current = dereference(root, ref);
  }
  return current;
}

function hasConstrainingSiblings(schema: JsonObject): boolean {
  for (const key of Object.keys(schema)) {
    if (key !== '$ref' && !ANNOTATION_KEYWORDS.has(key)) return true;
  }
  return false;
}

/**
 * Resolves a schema the way `resolve` does, but without losing keywords written
 * beside a `$ref` where the document's dialect makes them count. Such a schema
 * is the intersection of its target and its own keywords, so it is returned as
 * the equivalent `allOf`, which the comparator then merges like any other. The
 * result is memoised so the same schema always yields the same object.
 */
export function resolveSchema(doc: Document, value: unknown): JsonObject {
  let current = record(value);
  const seen = new Set<string>();
  while (typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (doc.refSiblingsApply && hasConstrainingSiblings(current)) {
      let composition = doc.refCompositions.get(current);
      if (!composition) {
        const siblings: JsonObject = {};
        for (const key of Object.keys(current)) {
          if (key !== '$ref' && !ANNOTATION_KEYWORDS.has(key)) siblings[key] = current[key];
        }
        composition = { allOf: [{ $ref: ref }, siblings] };
        doc.refCompositions.set(current, composition);
      }
      return composition;
    }
    if (seen.has(ref)) throw new Error(`Cyclic $ref alias: ${ref}`);
    seen.add(ref);
    current = dereference(doc.root, ref);
  }
  return current;
}

/**
 * The set of JSON types a schema permits, folding OpenAPI 3.0 `nullable: true`
 * into the 3.1 style type set so both dialects compare the same way.
 * An empty set means "unconstrained".
 *
 * Only a declared `type` constrains the instance type. Keywords such as
 * `properties` or `items` apply solely to instances that already are objects or
 * arrays, so they are never read as an implied type: a schema with `properties`
 * and no `type` still validates a string.
 */
export function effectiveTypes(schema: JsonObject): Set<string> {
  const types = new Set<string>();
  const declared = schema.type;
  if (typeof declared === 'string') types.add(declared);
  else if (Array.isArray(declared)) {
    for (const entry of declared) if (typeof entry === 'string') types.add(entry);
  }
  if (types.size > 0 && schema.nullable === true) types.add('null');
  return types;
}

/**
 * Whether a type set accepts every instance of `type`. JSON Schema defines one
 * such relation between type names: every `integer` is also a `number`.
 */
export function permits(types: Set<string>, type: string): boolean {
  return types.has(type) || (type === 'integer' && types.has('number'));
}

/** The types permitted by both sets, honouring `integer` being part of `number`. */
export function intersectTypes(left: Set<string>, right: Set<string>): Set<string> {
  const shared = new Set<string>();
  for (const type of left) if (permits(right, type)) shared.add(type);
  for (const type of right) if (permits(left, type)) shared.add(type);
  return shared;
}

export function formatTypes(types: Iterable<string>): string {
  return [...types].sort().join(' | ');
}

/** Distinct enum values keyed by their JSON form, or `null` when unconstrained. */
export function enumValues(schema: JsonObject): Map<string, unknown> | null {
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) return null;
  const values = new Map<string, unknown>();
  for (const value of schema.enum) values.set(valueKey(value), value);
  return values;
}

export function isClosedObject(schema: JsonObject): boolean {
  return schema.additionalProperties === false;
}

/**
 * Whether a validation keyword can affect any instance either side accepts.
 * A keyword only constrains instances of the types it applies to, so comparing
 * `minLength` on a pair of schemas that are both declared `number` would be
 * noise. An undeclared type means any instance is possible, so the keyword can
 * bite; this asks what the keywords constrain and never infers a type.
 */
export function constraintApplies(
  oldSchema: JsonObject,
  newSchema: JsonObject,
  applicable: readonly string[],
): boolean {
  const combined = new Set([...effectiveTypes(oldSchema), ...effectiveTypes(newSchema)]);
  if (combined.size === 0) return true;
  return applicable.some(type => combined.has(type));
}

/** One edge of a permitted range. `limit` may be infinite when absent. */
export interface Bound {
  limit: number;
  exclusive: boolean;
}

export const LOWER_UNBOUNDED: Bound = { limit: -Infinity, exclusive: false };
export const UPPER_UNBOUNDED: Bound = { limit: Infinity, exclusive: false };

export function isTighterLower(next: Bound, previous: Bound): boolean {
  if (next.limit !== previous.limit) return next.limit > previous.limit;
  return next.exclusive && !previous.exclusive;
}

export function isTighterUpper(next: Bound, previous: Bound): boolean {
  if (next.limit !== previous.limit) return next.limit < previous.limit;
  return next.exclusive && !previous.exclusive;
}

export function formatLower(bound: Bound): string {
  return bound.limit === -Infinity ? 'unbounded' : `${bound.exclusive ? '>' : '>='} ${bound.limit}`;
}

export function formatUpper(bound: Bound): string {
  return bound.limit === Infinity ? 'unbounded' : `${bound.exclusive ? '<' : '<='} ${bound.limit}`;
}

/** True when only integers are permitted, so exclusive bounds can be snapped. */
function isIntegerOnly(schema: JsonObject): boolean {
  const types = effectiveTypes(schema);
  return types.has('integer') && !types.has('number');
}

/** `exclusiveMinimum: 4` and `minimum: 5` accept the same integers. */
function snapLowerToInteger(bound: Bound): Bound {
  if (!bound.exclusive || !Number.isFinite(bound.limit)) return bound;
  return {
    limit: Number.isInteger(bound.limit) ? bound.limit + 1 : Math.ceil(bound.limit),
    exclusive: false,
  };
}

function snapUpperToInteger(bound: Bound): Bound {
  if (!bound.exclusive || !Number.isFinite(bound.limit)) return bound;
  return {
    limit: Number.isInteger(bound.limit) ? bound.limit - 1 : Math.floor(bound.limit),
    exclusive: false,
  };
}

/**
 * The lower bound as written, accepting both dialects: OpenAPI 3.0 writes
 * `minimum` with a boolean `exclusiveMinimum`, OpenAPI 3.1 writes a numeric
 * `exclusiveMinimum`. When both appear the stricter one wins.
 *
 * Integer snapping is deliberately left out here, because merging composed
 * schemas needs the raw bound: the effective type is only known once every
 * branch has been intersected.
 */
export function rawNumericLowerBound(schema: JsonObject): Bound {
  let bound = LOWER_UNBOUNDED;
  const minimum = schema.minimum;
  const exclusive = schema.exclusiveMinimum;
  if (typeof minimum === 'number') {
    const candidate: Bound = { limit: minimum, exclusive: exclusive === true };
    if (isTighterLower(candidate, bound)) bound = candidate;
  }
  if (typeof exclusive === 'number') {
    const candidate: Bound = { limit: exclusive, exclusive: true };
    if (isTighterLower(candidate, bound)) bound = candidate;
  }
  return bound;
}

export function rawNumericUpperBound(schema: JsonObject): Bound {
  let bound = UPPER_UNBOUNDED;
  const maximum = schema.maximum;
  const exclusive = schema.exclusiveMaximum;
  if (typeof maximum === 'number') {
    const candidate: Bound = { limit: maximum, exclusive: exclusive === true };
    if (isTighterUpper(candidate, bound)) bound = candidate;
  }
  if (typeof exclusive === 'number') {
    const candidate: Bound = { limit: exclusive, exclusive: true };
    if (isTighterUpper(candidate, bound)) bound = candidate;
  }
  return bound;
}

export function numericLowerBound(schema: JsonObject): Bound {
  const bound = rawNumericLowerBound(schema);
  return isIntegerOnly(schema) ? snapLowerToInteger(bound) : bound;
}

export function numericUpperBound(schema: JsonObject): Bound {
  const bound = rawNumericUpperBound(schema);
  return isIntegerOnly(schema) ? snapUpperToInteger(bound) : bound;
}

/** An absent `minLength`/`minItems` is the same as zero. */
export function countLowerBound(schema: JsonObject, keyword: string): Bound {
  const value = schema[keyword];
  return { limit: typeof value === 'number' ? value : 0, exclusive: false };
}

/** An absent `maxLength`/`maxItems` imposes no upper limit. */
export function countUpperBound(schema: JsonObject, keyword: string): Bound {
  const value = schema[keyword];
  return { limit: typeof value === 'number' ? value : Infinity, exclusive: false };
}

const CANONICAL_NODE_BUDGET = 20000;
const OVER_BUDGET = Symbol('canonical-over-budget');

/** Compositions whose branches may be reordered without changing the meaning. */
const UNORDERED_LIST_KEYWORDS: ReadonlySet<string> = new Set(['allOf', 'anyOf', 'oneOf']);
/** Of those, the ones where repeating a branch changes nothing either. */
const IDEMPOTENT_LIST_KEYWORDS: ReadonlySet<string> = new Set(['allOf', 'anyOf']);
/** Count keywords for which `0` is the same as leaving the keyword out. */
const ZERO_DEFAULT_KEYWORDS: ReadonlySet<string> = new Set(['minLength', 'minItems', 'minProperties']);
/** Boolean keywords for which `false` is the same as leaving the keyword out. */
const FALSE_DEFAULT_KEYWORDS: ReadonlySet<string> = new Set(['uniqueItems', 'nullable']);

interface CanonicalState {
  doc: Document;
  /** References being expanded, innermost last. */
  activeRefs: Set<string>;
  /** Active references that were re-entered below their own expansion. */
  reentered: Set<string>;
  budget: number;
}

/**
 * Builds a stable string for a schema with every internal `$ref` expanded, so
 * two schemas can be compared for equal meaning rather than equal spelling.
 *
 * The walk follows the grammar of a schema instead of treating it as a bag of
 * JSON. Annotations are dropped only where they are keywords; the keys of
 * `properties` and the other subschema maps are names and are all kept; the
 * values of `enum`, `const` and every keyword that is not known to hold a
 * subschema are data, copied whole with nothing dropped and nothing expanded.
 *
 * Spellings that provably accept the same instances are folded together:
 * object key order, the order of `required`, `enum`, `type` and of
 * `allOf`/`anyOf`/`oneOf` branches, repeated `allOf`/`anyOf` branches,
 * `nullable: true` against a `"null"` type, and keywords set to the value they
 * have when absent. Nothing else is: when in doubt two schemas stay different,
 * which callers report for review.
 *
 * A reference that re-enters itself is replaced by a marker naming the pointer,
 * and the place it was first expanded is marked as well, so a recursive schema
 * stays finite without two different recursions collapsing into one string.
 *
 * Returns `null` when the schema is too large to canonicalise, which callers
 * must treat as "cannot tell" rather than "equal".
 */
export function canonicalize(doc: Document, value: unknown): string | null {
  const cacheable = value !== null && typeof value === 'object';
  if (cacheable) {
    const cached = doc.canonical.get(value as JsonObject);
    if (cached !== undefined) return cached === '' ? null : cached;
  }
  let result: string | null;
  try {
    const state: CanonicalState = {
      doc, activeRefs: new Set(), reentered: new Set(), budget: CANONICAL_NODE_BUDGET,
    };
    result = valueKey(canonicalSchema(state, value));
  } catch (error) {
    if (error !== OVER_BUDGET) throw error;
    result = null;
  }
  if (cacheable) doc.canonical.set(value as JsonObject, result ?? '');
  return result;
}

function spend(state: CanonicalState): void {
  if (--state.budget < 0) throw OVER_BUDGET;
}

/** Plain JSON: keys sorted, nothing dropped, no reference followed. */
function canonicalData(state: CanonicalState, value: unknown): unknown {
  spend(state);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => canonicalData(state, item));
  const source = value as JsonObject;
  const data: JsonObject = {};
  for (const key of Object.keys(source).sort()) data[key] = canonicalData(state, source[key]);
  return data;
}

function sortedByKey(values: unknown[], distinct: boolean): unknown[] {
  const keyed = values.map(value => ({ key: valueKey(value), value }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keyed
    .filter((entry, index) => !distinct || index === 0 || keyed[index - 1].key !== entry.key)
    .map(entry => entry.value);
}

/** A value in schema position: an object, or the boolean schemas `true`/`false`. */
function canonicalSchema(state: CanonicalState, value: unknown): unknown {
  if (value === true) {
    spend(state);
    return {};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return canonicalData(state, value);
  }
  spend(state);

  const schema = value as JsonObject;
  const ref = schema.$ref;
  if (typeof ref !== 'string') return canonicalKeywords(state, schema, {});

  let resolved: unknown;
  if (!ref.startsWith('#/')) resolved = { $externalRef: ref };
  else if (state.activeRefs.has(ref)) {
    state.reentered.add(ref);
    resolved = { $cyclicRef: ref };
  } else {
    const target = lookupPointer(state.doc.root, ref);
    if (target === undefined) resolved = { $unresolvedRef: ref };
    else {
      state.activeRefs.add(ref);
      try {
        resolved = canonicalSchema(state, target);
      } finally {
        state.activeRefs.delete(ref);
      }
      // Mark where a recursion is anchored; a cycle back to this point is not
      // the same schema as a cycle back to somewhere else.
      if (state.reentered.delete(ref)) resolved = { $recursiveRef: ref, $target: resolved };
    }
  }

  const siblings = canonicalKeywords(state, schema, {});
  if (Object.keys(siblings).length === 0) return resolved;
  return { $resolved: resolved, ...siblings };
}

function canonicalKeywords(state: CanonicalState, schema: JsonObject, out: JsonObject): JsonObject {
  const types = effectiveTypes(schema);
  for (const key of Object.keys(schema).sort()) {
    if (key === '$ref' || ANNOTATION_KEYWORDS.has(key)) continue;
    const value = schema[key];

    if (types.size > 0 && (key === 'type' || key === 'nullable')) {
      // Every integer is a number, so naming both adds nothing.
      if (key === 'type') out.type = [...types].filter(type => type !== 'integer' || !types.has('number')).sort();
      continue;
    }
    if (ZERO_DEFAULT_KEYWORDS.has(key) && value === 0) continue;
    if (FALSE_DEFAULT_KEYWORDS.has(key) && value === false) continue;

    if (SUBSCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
      const map: JsonObject = {};
      for (const name of Object.keys(value).sort()) map[name] = canonicalSchema(state, value[name]);
      out[key] = map;
    } else if ((SUBSCHEMA_LIST_KEYWORDS.has(key) || key === 'items') && Array.isArray(value)) {
      const branches = value.map(item => canonicalSchema(state, item));
      out[key] = UNORDERED_LIST_KEYWORDS.has(key)
        ? sortedByKey(branches, IDEMPOTENT_LIST_KEYWORDS.has(key))
        : branches;
    } else if (SUBSCHEMA_KEYWORDS.has(key)) {
      out[key] = canonicalSchema(state, value);
    } else if (key === 'dependencies' && isPlainObject(value)) {
      // Draft-04 style: a name maps to either a schema or a list of names.
      const map: JsonObject = {};
      for (const name of Object.keys(value).sort()) {
        const entry = value[name];
        map[name] = Array.isArray(entry) ? canonicalData(state, entry) : canonicalSchema(state, entry);
      }
      out[key] = map;
    } else if (key === 'required' && Array.isArray(value) && value.every(item => typeof item === 'string')) {
      if (value.length > 0) out[key] = sortedByKey(value, true);
    } else if (key === 'enum' && Array.isArray(value)) {
      out[key] = sortedByKey(value.map(item => canonicalData(state, item)), true);
    } else {
      out[key] = canonicalData(state, value);
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
