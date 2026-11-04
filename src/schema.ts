import type { JsonObject } from './types';

/**
 * Keywords that carry no validation meaning. They are dropped when schemas are
 * merged or canonicalised, so two schemas that differ only in their prose are
 * treated as the same contract.
 */
export const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  'title', 'description', 'summary', 'example', 'examples', 'default', 'deprecated',
  '$comment', '$id', '$schema', '$anchor', 'externalDocs', 'xml', 'discriminator',
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
}

export function documentFor(root: JsonObject): Document {
  return { root, flattened: new WeakMap(), canonical: new WeakMap() };
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
    let target: unknown = root;
    for (const key of pointerSegments(ref)) {
      target = record(target)[key];
      if (target === undefined) throw new Error(`Unresolved OpenAPI reference: ${ref}`);
    }
    current = record(target);
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

/**
 * Builds a stable string for a schema with every internal `$ref` expanded and
 * object keys sorted, so two schemas can be compared for equal meaning rather
 * than equal spelling. A reference that re-enters itself is replaced by a
 * marker naming the pointer, which keeps recursive schemas finite while still
 * distinguishing different targets.
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
    result = valueKey(canonicalNode(doc, value, new Set<string>(), { left: CANONICAL_NODE_BUDGET }));
  } catch (error) {
    if (error !== OVER_BUDGET) throw error;
    result = null;
  }
  if (cacheable) doc.canonical.set(value as JsonObject, result ?? '');
  return result;
}

function canonicalNode(
  doc: Document,
  value: unknown,
  activeRefs: Set<string>,
  budget: { left: number },
): unknown {
  if (--budget.left < 0) throw OVER_BUDGET;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => canonicalNode(doc, item, activeRefs, budget));

  const schema = value as JsonObject;
  const ref = schema.$ref;
  if (typeof ref === 'string') {
    if (!ref.startsWith('#/')) return { $externalRef: ref };
    if (activeRefs.has(ref)) return { $cyclicRef: ref };
    let target: unknown = doc.root;
    for (const key of pointerSegments(ref)) {
      target = record(target)[key];
      if (target === undefined) return { $unresolvedRef: ref };
    }
    activeRefs.add(ref);
    try {
      const resolved = canonicalNode(doc, target, activeRefs, budget);
      const siblings = Object.keys(schema)
        .filter(key => key !== '$ref' && !ANNOTATION_KEYWORDS.has(key))
        .sort();
      if (siblings.length === 0) return resolved;
      const combined: JsonObject = { $resolved: resolved };
      for (const key of siblings) combined[key] = canonicalNode(doc, schema[key], activeRefs, budget);
      return combined;
    } finally {
      activeRefs.delete(ref);
    }
  }

  const canonical: JsonObject = {};
  for (const key of Object.keys(schema).sort()) {
    if (ANNOTATION_KEYWORDS.has(key)) continue;
    canonical[key] = canonicalNode(doc, schema[key], activeRefs, budget);
  }
  return canonical;
}
