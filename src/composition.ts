import type { JsonObject } from './types';
import {
  Bound,
  Document,
  FlattenedSchema,
  LOWER_UNBOUNDED,
  UPPER_UNBOUNDED,
  ANNOTATION_KEYWORDS,
  canonicalize,
  countLowerBound,
  countUpperBound,
  effectiveTypes,
  enumValues,
  intersectTypes,
  isTighterLower,
  isTighterUpper,
  rawNumericLowerBound,
  rawNumericUpperBound,
  record,
  resolve,
  strings,
  valueKey,
} from './schema';

/**
 * Keywords this module merges itself. Everything else found in a branch is
 * carried over untouched when exactly one branch declares it, and blocks the
 * merge when branches disagree — an intersection of two different `pattern`s or
 * two different `oneOf`s cannot be expressed as a single schema.
 */
const MERGED_KEYWORDS: ReadonlySet<string> = new Set([
  'allOf', 'type', 'nullable', 'enum', 'required', 'properties', 'items',
  'additionalProperties',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
]);

const COUNT_LOWER_KEYWORDS = ['minLength', 'minItems', 'minProperties'] as const;
const COUNT_UPPER_KEYWORDS = ['maxLength', 'maxItems', 'maxProperties'] as const;

/** Placed in the cache while a schema is being merged, so a branch that
 * references the schema being merged is reported as cyclic instead of looping. */
const MERGE_IN_PROGRESS: FlattenedSchema = {
  schema: {},
  exact: false,
  reason: 'the composition references itself through `allOf`',
};

function inexact(schema: JsonObject, reason: string): FlattenedSchema {
  return { schema, exact: false, reason };
}

/**
 * Merges `allOf` into a single effective schema.
 *
 * `allOf` is an intersection of constraints, not inheritance: each branch is
 * applied to the whole instance independently. A merge is therefore only
 * reported as `exact` when intersecting the branches keyword by keyword accepts
 * exactly what the original composition accepts. Where that cannot be
 * guaranteed the original schema is returned with `exact: false` and a reason,
 * and the caller must treat the comparison as inconclusive.
 */
export function flattenAllOf(doc: Document, schema: JsonObject): FlattenedSchema {
  const cached = doc.flattened.get(schema);
  if (cached) return cached;
  doc.flattened.set(schema, MERGE_IN_PROGRESS);
  const result = mergeAllOf(doc, schema);
  doc.flattened.set(schema, result);
  return result;
}

function mergeAllOf(doc: Document, schema: JsonObject): FlattenedSchema {
  if (!('allOf' in schema)) return { schema, exact: true, reason: null };
  const branches = schema.allOf;
  if (!Array.isArray(branches) || branches.length === 0) {
    return inexact(schema, '`allOf` is not a non-empty array');
  }

  // The enclosing schema constrains the instance alongside its branches, so it
  // takes part in the intersection as a unit of its own.
  const units: JsonObject[] = [];
  const enclosing: JsonObject = {};
  for (const key of Object.keys(schema)) {
    if (key !== 'allOf' && !ANNOTATION_KEYWORDS.has(key)) enclosing[key] = schema[key];
  }
  if (Object.keys(enclosing).length > 0) units.push(enclosing);

  for (const raw of branches) {
    let resolved: JsonObject;
    try {
      resolved = resolve(doc.root, raw);
    } catch {
      return inexact(schema, 'a branch reference could not be resolved');
    }
    const inner = flattenAllOf(doc, resolved);
    if (!inner.exact) {
      return inexact(schema, inner.reason ?? 'a nested branch could not be merged');
    }
    units.push(inner.schema);
  }
  if (units.length === 1) return { schema: units[0], exact: true, reason: null };

  const merged: JsonObject = {};

  // Keywords this module does not understand: safe only while branches agree.
  for (const unit of units) {
    for (const keyword of Object.keys(unit)) {
      if (MERGED_KEYWORDS.has(keyword) || ANNOTATION_KEYWORDS.has(keyword)) continue;
      if (keyword in merged) {
        if (valueKey(merged[keyword]) !== valueKey(unit[keyword])) {
          return inexact(schema, `branches declare conflicting \`${keyword}\``);
        }
        continue;
      }
      merged[keyword] = unit[keyword];
    }
  }

  const extras = mergeAdditionalProperties(units);
  if (extras.blocked) return inexact(schema, extras.blocked);
  if (extras.value !== undefined) merged.additionalProperties = extras.value;

  const declaredTypes = units.map(effectiveTypes).filter(types => types.size > 0);
  if (declaredTypes.length > 0) {
    const shared = declaredTypes.reduce(intersectTypes);
    if (shared.size === 0) return inexact(schema, 'branch types do not intersect');
    merged.type = shared.size === 1 ? [...shared][0] : [...shared].sort();
  }

  const declaredEnums = units
    .map(enumValues)
    .filter((values): values is Map<string, unknown> => values !== null);
  if (declaredEnums.length > 0) {
    const shared = declaredEnums.reduce((left, right) => {
      const kept = new Map<string, unknown>();
      for (const [key, value] of left) if (right.has(key)) kept.set(key, value);
      return kept;
    });
    if (shared.size === 0) return inexact(schema, 'branch enums do not intersect');
    merged.enum = [...shared.values()];
  }

  const required = new Set<string>();
  for (const unit of units) for (const name of strings(unit.required)) required.add(name);
  if (required.size > 0) merged.required = [...required].sort();

  const properties = mergeSubschemas(units, 'properties');
  if (properties) merged.properties = properties;

  const items = units.filter(unit => unit.items !== undefined).map(unit => unit.items);
  if (items.length === 1) merged.items = items[0];
  else if (items.length > 1) merged.items = { allOf: items };

  writeNumericBounds(units, merged);
  writeCountBounds(units, merged);

  return { schema: merged, exact: true, reason: null };
}

/**
 * `additionalProperties` is the keyword that makes naive flattening unsound. It
 * only knows about the `properties` written beside it, so
 * `allOf: [{properties: {a}}, {additionalProperties: false}]` rejects every
 * object, while the naive merge would happily accept `{a: 1}`.
 *
 * Merging is therefore only allowed when every property name declared anywhere
 * in the composition also appears in each branch that closes the object, which
 * is exactly when moving the keyword next to the merged properties changes
 * nothing.
 */
function mergeAdditionalProperties(units: JsonObject[]): { value?: unknown; blocked?: string } {
  const closing = units.filter(unit => 'additionalProperties' in unit);
  if (closing.length === 0) return {};
  if (units.some(unit => 'patternProperties' in unit || 'unevaluatedProperties' in unit)) {
    return { blocked: '`additionalProperties` is combined with `patternProperties` or `unevaluatedProperties`' };
  }

  const declared = new Set<string>();
  for (const unit of units) for (const name of Object.keys(record(unit.properties))) declared.add(name);
  for (const unit of closing) {
    const own = new Set(Object.keys(record(unit.properties)));
    for (const name of declared) {
      if (!own.has(name)) {
        return { blocked: '`additionalProperties` in one branch would reject properties declared in another' };
      }
    }
  }

  const values = closing.map(unit => unit.additionalProperties);
  if (values.some(value => value === false)) return { value: false };
  const distinct = new Set(values.map(valueKey));
  if (distinct.size > 1) return { blocked: 'branches declare different `additionalProperties` schemas' };
  return { value: values[0] };
}

/**
 * Collects a keyword holding a map of subschemas. A name declared by several
 * branches becomes an `allOf` of those branches, because the instance has to
 * satisfy every one of them; the comparator merges that nested composition when
 * it walks into the property.
 */
function mergeSubschemas(units: JsonObject[], keyword: string): JsonObject | null {
  const collected = new Map<string, unknown[]>();
  for (const unit of units) {
    for (const [name, value] of Object.entries(record(unit[keyword]))) {
      const existing = collected.get(name);
      if (existing) existing.push(value);
      else collected.set(name, [value]);
    }
  }
  if (collected.size === 0) return null;
  const merged: JsonObject = {};
  for (const [name, schemas] of collected) {
    merged[name] = schemas.length === 1 ? schemas[0] : { allOf: schemas };
  }
  return merged;
}

/** The intersection of numeric ranges is the strictest bound from any branch. */
function writeNumericBounds(units: JsonObject[], merged: JsonObject): void {
  let lower = LOWER_UNBOUNDED;
  let upper = UPPER_UNBOUNDED;
  for (const unit of units) {
    const unitLower = rawNumericLowerBound(unit);
    if (isTighterLower(unitLower, lower)) lower = unitLower;
    const unitUpper = rawNumericUpperBound(unit);
    if (isTighterUpper(unitUpper, upper)) upper = unitUpper;
  }
  if (Number.isFinite(lower.limit)) {
    if (lower.exclusive) merged.exclusiveMinimum = lower.limit;
    else merged.minimum = lower.limit;
  }
  if (Number.isFinite(upper.limit)) {
    if (upper.exclusive) merged.exclusiveMaximum = upper.limit;
    else merged.maximum = upper.limit;
  }
}

function writeCountBounds(units: JsonObject[], merged: JsonObject): void {
  for (const keyword of COUNT_LOWER_KEYWORDS) {
    let bound: Bound = { limit: 0, exclusive: false };
    for (const unit of units) {
      const unitBound = countLowerBound(unit, keyword);
      if (isTighterLower(unitBound, bound)) bound = unitBound;
    }
    if (bound.limit > 0) merged[keyword] = bound.limit;
  }
  for (const keyword of COUNT_UPPER_KEYWORDS) {
    let bound: Bound = { limit: Infinity, exclusive: false };
    for (const unit of units) {
      const unitBound = countUpperBound(unit, keyword);
      if (isTighterUpper(unitBound, bound)) bound = unitBound;
    }
    if (Number.isFinite(bound.limit)) merged[keyword] = bound.limit;
  }
}

/**
 * How a list of alternatives changed. `added` means every former alternative is
 * still present, `removed` means no new alternative appeared, and `changed`
 * means both happened at once.
 */
export type BranchDelta = 'unchanged' | 'added' | 'removed' | 'changed' | 'indeterminate';

function canonicalMultiset(doc: Document, branches: unknown[]): Map<string, number> | null {
  const counts = new Map<string, number>();
  for (const branch of branches) {
    const key = canonicalize(doc, branch);
    if (key === null) return null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function covers(outer: Map<string, number>, inner: Map<string, number>): boolean {
  for (const [key, count] of inner) {
    if ((outer.get(key) ?? 0) < count) return false;
  }
  return true;
}

/**
 * Compares two lists of alternatives as multisets of fully resolved schemas, so
 * reordering the alternatives, or renaming the `$ref` that reaches an unchanged
 * one, is recognised as no change at all.
 */
export function compareBranchLists(
  before: Document,
  beforeBranches: unknown[],
  after: Document,
  afterBranches: unknown[],
): BranchDelta {
  const left = canonicalMultiset(before, beforeBranches);
  const right = canonicalMultiset(after, afterBranches);
  if (!left || !right) return 'indeterminate';
  const leftCoversRight = covers(left, right);
  const rightCoversLeft = covers(right, left);
  if (leftCoversRight && rightCoversLeft) return 'unchanged';
  if (rightCoversLeft) return 'added';
  if (leftCoversRight) return 'removed';
  return 'changed';
}
