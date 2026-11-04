import type { ComparisonResult, Finding, JsonObject } from './types';
import {
  Bound,
  Document,
  NUMERIC_TYPES,
  canonicalize,
  constraintApplies,
  countLowerBound,
  countUpperBound,
  documentFor,
  effectiveTypes,
  enumValues,
  formatLower,
  formatTypes,
  formatUpper,
  isClosedObject,
  isTighterLower,
  isTighterUpper,
  numericLowerBound,
  numericUpperBound,
  permits,
  record,
  resolve,
  strings,
  valueKey,
} from './schema';
import { BranchDelta, compareBranchLists, flattenAllOf } from './composition';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Alternatives, handled by proof rather than by merging. */
const UNION_KEYWORDS = ['anyOf', 'oneOf'] as const;

/**
 * Guards against a schema graph that defeats the cycle checks. Real documents
 * nest nowhere near this deep, so reaching it means something is wrong and the
 * subschema is reported as not compared instead of risking a stack overflow.
 */
const MAX_SCHEMA_DEPTH = 64;

/**
 * Validation keywords that affect compatibility but cannot be compared
 * reliably: `pattern` would need regular expression inclusion analysis,
 * `format` needs a registry of value spaces, and the rest need instance-level
 * reasoning. A change to any of them is surfaced as a notice rather than
 * passed over as compatible.
 */
const UNCOMPARED_CONSTRAINTS = [
  'multipleOf',
  'pattern',
  'format',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'propertyNames',
  'dependentRequired',
  'dependentSchemas',
  'const',
  'readOnly',
  'writeOnly',
  'unevaluatedProperties',
  'unevaluatedItems',
  'not',
  'if',
  'then',
  'else',
] as const;

/**
 * Compatibility is directional: a request schema may only get more permissive,
 * a response schema may only get more restrictive.
 */
type Direction = 'request' | 'response';

interface Reporter {
  /** A change that can break existing clients. */
  breaking(code: string, location: string, message: string): void;
  /** A place the rule set could not evaluate; never fails the check on its own. */
  notice(code: string, location: string, message: string): void;
}

const RANGE_RULES = {
  range: { narrowed: 'REQUEST_RANGE_NARROWED', widened: 'RESPONSE_RANGE_WIDENED' },
  length: { narrowed: 'REQUEST_LENGTH_NARROWED', widened: 'RESPONSE_LENGTH_WIDENED' },
  items: { narrowed: 'REQUEST_ITEM_COUNT_NARROWED', widened: 'RESPONSE_ITEM_COUNT_WIDENED' },
} as const;

type RangeFamily = keyof typeof RANGE_RULES;

/**
 * A request may only accept more than before and a response may only return
 * less, so a tightened request bound and a relaxed response bound both break
 * deployed clients.
 */
function compareBound(
  before: Bound,
  after: Bound,
  edge: 'lower' | 'upper',
  family: RangeFamily,
  label: string,
  location: string,
  direction: Direction,
  report: Reporter,
): void {
  const isTighter = edge === 'lower' ? isTighterLower : isTighterUpper;
  const format = edge === 'lower' ? formatLower : formatUpper;
  const rules = RANGE_RULES[family];
  if (direction === 'request') {
    if (isTighter(after, before)) {
      report.breaking(rules.narrowed, location,
        `${label} tightened (${format(before)} → ${format(after)}); requests that were valid are now rejected.`);
    }
    return;
  }
  if (isTighter(before, after)) {
    report.breaking(rules.widened, location,
      `${label} relaxed (${format(before)} → ${format(after)}); responses may now fall outside the documented range.`);
  }
}

function compareConstraints(
  oldSchema: JsonObject,
  newSchema: JsonObject,
  location: string,
  direction: Direction,
  report: Reporter,
): void {
  if (constraintApplies(oldSchema, newSchema, NUMERIC_TYPES)) {
    compareBound(numericLowerBound(oldSchema), numericLowerBound(newSchema),
      'lower', 'range', 'Minimum', location, direction, report);
    compareBound(numericUpperBound(oldSchema), numericUpperBound(newSchema),
      'upper', 'range', 'Maximum', location, direction, report);
  }
  if (constraintApplies(oldSchema, newSchema, ['string'])) {
    compareBound(countLowerBound(oldSchema, 'minLength'), countLowerBound(newSchema, 'minLength'),
      'lower', 'length', 'Minimum length', location, direction, report);
    compareBound(countUpperBound(oldSchema, 'maxLength'), countUpperBound(newSchema, 'maxLength'),
      'upper', 'length', 'Maximum length', location, direction, report);
  }
  if (constraintApplies(oldSchema, newSchema, ['array'])) {
    compareBound(countLowerBound(oldSchema, 'minItems'), countLowerBound(newSchema, 'minItems'),
      'lower', 'items', 'Minimum item count', location, direction, report);
    compareBound(countUpperBound(oldSchema, 'maxItems'), countUpperBound(newSchema, 'maxItems'),
      'upper', 'items', 'Maximum item count', location, direction, report);
  }
}

/**
 * A request may widen its accepted types; a response may only narrow the types
 * it produces. Anything else can break a client that is already deployed.
 */
function compareTypes(
  oldSchema: JsonObject,
  newSchema: JsonObject,
  location: string,
  direction: Direction,
  report: Reporter,
): void {
  const before = effectiveTypes(oldSchema);
  const after = effectiveTypes(newSchema);
  if (before.size === 0 && after.size === 0) return;

  if (before.size === 0) {
    if (direction === 'request') {
      report.breaking('SCHEMA_TYPE_CHANGED', location,
        `Request value was unconstrained and is now limited to ${formatTypes(after)}.`);
    }
    return;
  }
  if (after.size === 0) {
    if (direction === 'response') {
      report.breaking('SCHEMA_TYPE_CHANGED', location,
        `Response type constraint removed (was ${formatTypes(before)}); any value may now be returned.`);
    }
    return;
  }

  if (direction === 'request') {
    const removed = [...before].filter(type => !permits(after, type));
    if (removed.length) {
      report.breaking('SCHEMA_TYPE_CHANGED', location,
        `Request no longer accepts ${formatTypes(removed)} (${formatTypes(before)} → ${formatTypes(after)}).`);
    }
    return;
  }
  const added = [...after].filter(type => !permits(before, type));
  if (added.length) {
    report.breaking('SCHEMA_TYPE_CHANGED', location,
      `Response may now return ${formatTypes(added)} (${formatTypes(before)} → ${formatTypes(after)}).`);
  }
}

/**
 * Requests break when accepted values disappear; responses break when new
 * values appear that deployed clients have never seen.
 */
function compareEnums(
  oldSchema: JsonObject,
  newSchema: JsonObject,
  location: string,
  direction: Direction,
  report: Reporter,
): void {
  const before = enumValues(oldSchema);
  const after = enumValues(newSchema);

  if (direction === 'request') {
    if (!before && after) {
      report.breaking('REQUEST_ENUM_NARROWED', location,
        `Enum constraint introduced; only ${[...after.keys()].join(', ')} are accepted now.`);
      return;
    }
    if (before && after) {
      const removed = [...before.keys()].filter(key => !after.has(key));
      if (removed.length) {
        report.breaking('REQUEST_ENUM_NARROWED', location,
          `Previously allowed values removed: ${removed.join(', ')}.`);
      }
    }
    return;
  }

  if (before && !after) {
    report.breaking('RESPONSE_ENUM_EXPANDED', location,
      `Enum constraint removed (was ${[...before.keys()].join(', ')}); any value may now be returned.`);
    return;
  }
  if (before && after) {
    const added = [...after.keys()].filter(key => !before.has(key));
    if (added.length) {
      report.breaking('RESPONSE_ENUM_EXPANDED', location,
        `New values existing clients may not handle: ${added.join(', ')}.`);
    }
  }
}

function unionNotice(keyword: string, delta: BranchDelta, direction: Direction): string {
  if (delta === 'indeterminate') {
    return `\`${keyword}\` alternatives were too large to compare; review this subschema manually.`;
  }
  const change = delta === 'added' ? 'were added'
    : delta === 'removed' ? 'were removed'
      : 'were both added and removed';
  if (keyword === 'oneOf') {
    return `\`oneOf\` alternatives ${change}; because exactly one alternative must match, overlapping alternatives can invalidate instances that were valid before. Review this subschema manually.`;
  }
  if (delta === 'added') {
    return `\`anyOf\` alternatives ${change}; a response may now return instances matching the new alternative unless it was already covered. Review this subschema manually.`;
  }
  if (delta === 'removed') {
    return `\`anyOf\` alternatives ${change}; a remaining alternative may still accept the same instances, so whether anything is now rejected cannot be established. Review this subschema manually.`;
  }
  return `\`anyOf\` alternatives ${change}; review this subschema manually.`;
}

/**
 * Alternatives are compared as whole lists, never branch against branch: pairing
 * them up would invent a correspondence the schema does not have.
 *
 * Two cases are provable and stay silent. Adding an `anyOf` alternative cannot
 * reject a request that was accepted before, because every former alternative
 * is still there; removing one cannot give a response client a value it could
 * not already receive. Everything else, including every `oneOf` change, depends
 * on whether alternatives overlap and is reported for review.
 */
function compareUnions(
  before: Document,
  after: Document,
  oldSchema: JsonObject,
  newSchema: JsonObject,
  location: string,
  direction: Direction,
  report: Reporter,
): void {
  for (const keyword of UNION_KEYWORDS) {
    const oldBranches = oldSchema[keyword];
    const newBranches = newSchema[keyword];
    const oldDeclared = Array.isArray(oldBranches);
    const newDeclared = Array.isArray(newBranches);
    if (!oldDeclared && !newDeclared) continue;
    if (oldDeclared !== newDeclared) {
      report.notice('UNSUPPORTED_COMPOSITION', location,
        `\`${keyword}\` was ${oldDeclared ? 'removed' : 'added'}; whether the same instances are still accepted cannot be established. Review this subschema manually.`);
      continue;
    }
    const delta = compareBranchLists(before, oldBranches as unknown[], after, newBranches as unknown[]);
    if (delta === 'unchanged') continue;
    if (keyword === 'anyOf' && direction === 'request' && delta === 'added') continue;
    if (keyword === 'anyOf' && direction === 'response' && delta === 'removed') continue;
    report.notice('UNSUPPORTED_COMPOSITION', location, unionNotice(keyword, delta, direction));
  }
}

/** Flags keywords that are present but not evaluated, so reports stay honest. */
function noteUnevaluatedKeywords(
  oldSchema: JsonObject,
  newSchema: JsonObject,
  location: string,
  report: Reporter,
): void {
  if ('prefixItems' in oldSchema || 'prefixItems' in newSchema) {
    report.notice('UNSUPPORTED_TUPLE_ITEMS', location,
      'Tuple validation (`prefixItems`) is not evaluated; review positional array changes manually.');
  }
}

function describeConstraint(value: unknown): string {
  if (value === undefined) return 'absent';
  const text = valueKey(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Reports validation keywords that changed but cannot be evaluated, so a clean
 * breaking list is never mistaken for proof that the constraint still holds.
 * An unchanged keyword cannot affect compatibility, so it stays quiet.
 */
function noteChangedConstraints(
  oldSchema: JsonObject,
  newSchema: JsonObject,
  location: string,
  report: Reporter,
): void {
  for (const keyword of UNCOMPARED_CONSTRAINTS) {
    const before = oldSchema[keyword];
    const after = newSchema[keyword];
    if (before === undefined && after === undefined) continue;
    if (valueKey(before) === valueKey(after)) continue;
    report.notice('CONSTRAINT_NOT_COMPARED', location,
      `\`${keyword}\` changed (${describeConstraint(before)} → ${describeConstraint(after)}); this constraint is not evaluated and must be reviewed manually.`);
  }
  const beforeExtras = oldSchema.additionalProperties;
  const afterExtras = newSchema.additionalProperties;
  if (typeof beforeExtras === 'object' && beforeExtras !== null
    && typeof afterExtras === 'object' && afterExtras !== null
    && valueKey(beforeExtras) !== valueKey(afterExtras)) {
    report.notice('CONSTRAINT_NOT_COMPARED', location,
      'The `additionalProperties` subschema changed; undeclared property compatibility was not evaluated.');
  }
}

/** True when both schemas mean the same thing once references are expanded. */
function sameMeaning(
  before: Document,
  oldSchema: JsonObject,
  after: Document,
  newSchema: JsonObject,
): boolean {
  const left = canonicalize(before, oldSchema);
  const right = canonicalize(after, newSchema);
  return left !== null && right !== null && left === right;
}

function compareSchema(
  before: Document,
  after: Document,
  oldRaw: unknown,
  newRaw: unknown,
  location: string,
  direction: Direction,
  report: Reporter,
  seen: WeakMap<object, WeakSet<object>>,
  depth: number,
): void {
  const oldResolved = resolve(before.root, oldRaw);
  const newResolved = resolve(after.root, newRaw);
  const visited = seen.get(oldResolved);
  if (visited?.has(newResolved)) return;
  if (visited) visited.add(newResolved);
  else seen.set(oldResolved, new WeakSet([newResolved]));

  if (depth > MAX_SCHEMA_DEPTH) {
    report.notice('SCHEMA_NOT_COMPARED', location,
      `Schema nesting passed ${MAX_SCHEMA_DEPTH} levels; this subschema was not compared.`);
    return;
  }

  // `allOf` is merged into an effective schema first, so every rule below sees
  // the constraints of all branches at once.
  const oldFlat = flattenAllOf(before, oldResolved);
  const newFlat = flattenAllOf(after, newResolved);
  if (!oldFlat.exact || !newFlat.exact) {
    // An unmergeable composition that did not change needs no review.
    if (!sameMeaning(before, oldResolved, after, newResolved)) {
      const reason = (oldFlat.exact ? newFlat.reason : oldFlat.reason) ?? 'unsupported composition';
      report.notice('UNSUPPORTED_COMPOSITION', location,
        `Composed schema could not be merged without changing its meaning (${reason}); review this subschema manually.`);
    }
    return;
  }
  const oldSchema = oldFlat.schema;
  const newSchema = newFlat.schema;

  noteUnevaluatedKeywords(oldSchema, newSchema, location, report);
  noteChangedConstraints(oldSchema, newSchema, location, report);
  compareUnions(before, after, oldSchema, newSchema, location, direction, report);
  compareTypes(oldSchema, newSchema, location, direction, report);
  compareEnums(oldSchema, newSchema, location, direction, report);
  compareConstraints(oldSchema, newSchema, location, direction, report);

  const oldProperties = record(oldSchema.properties);
  const newProperties = record(newSchema.properties);
  const oldRequired = new Set(strings(oldSchema.required));
  const newRequired = new Set(strings(newSchema.required));

  if (direction === 'request') {
    for (const name of newRequired) {
      if (!oldRequired.has(name)) {
        report.breaking('REQUEST_FIELD_REQUIRED', `${location}.${name}`, 'Field is now required.');
      }
    }
    if (!isClosedObject(oldSchema) && isClosedObject(newSchema)
      && constraintApplies(oldSchema, newSchema, ['object'])) {
      report.breaking('REQUEST_OBJECT_CLOSED', location,
        'Object now rejects undeclared properties (additionalProperties: false); requests carrying extra fields are refused.');
    }
    for (const name of Object.keys(oldProperties)) {
      if (!(name in newProperties) && isClosedObject(newSchema)) {
        report.breaking('REQUEST_FIELD_REMOVED', `${location}.${name}`, 'Previously accepted field removed from a closed object schema.');
      }
    }
  } else {
    for (const name of Object.keys(oldProperties)) {
      if (!(name in newProperties)) {
        report.breaking('RESPONSE_FIELD_REMOVED', `${location}.${name}`, 'Response field removed.');
      } else if (oldRequired.has(name) && !newRequired.has(name)) {
        report.breaking('RESPONSE_FIELD_OPTIONAL', `${location}.${name}`, 'Previously guaranteed response field is now optional.');
      }
    }
  }

  for (const name of Object.keys(oldProperties)) {
    if (name in newProperties) {
      compareSchema(before, after, oldProperties[name], newProperties[name],
        `${location}.${name}`, direction, report, seen, depth + 1);
    }
  }

  const oldItems = oldSchema.items;
  const newItems = newSchema.items;
  if (oldItems !== undefined && newItems !== undefined) {
    compareSchema(before, after, oldItems, newItems, `${location}[]`, direction, report, seen, depth + 1);
  } else if (oldItems !== undefined || newItems !== undefined) {
    report.notice('SCHEMA_NOT_COMPARED', `${location}[]`,
      `Array item schema is declared on only the ${oldItems !== undefined ? 'base' : 'head'} side; element compatibility was not evaluated.`);
  }
}

function compareContent(
  before: Document,
  after: Document,
  oldContent: unknown,
  newContent: unknown,
  location: string,
  direction: Direction,
  report: Reporter,
): void {
  const oldTypes = record(oldContent);
  const newTypes = record(newContent);
  for (const [mediaType, rawOld] of Object.entries(oldTypes)) {
    const where = `${location} [${mediaType}]`;
    if (!(mediaType in newTypes)) {
      report.breaking('MEDIA_TYPE_REMOVED', where, `${direction === 'request' ? 'Accepted request' : 'Produced response'} media type removed.`);
      continue;
    }
    const oldSchema = record(rawOld).schema;
    const newSchema = record(newTypes[mediaType]).schema;
    if (oldSchema !== undefined && newSchema !== undefined) {
      compareSchema(before, after, oldSchema, newSchema, where, direction, report, new WeakMap(), 0);
    } else if (oldSchema !== undefined || newSchema !== undefined) {
      report.notice('SCHEMA_NOT_COMPARED', where,
        `A schema is declared on only the ${oldSchema !== undefined ? 'base' : 'head'} side of this media type; payload compatibility was not evaluated.`);
    }
  }
}

/** Path parameters are always required, whether or not `required: true` is written out. */
function isRequiredParameter(parameter: JsonObject): boolean {
  return parameter.required === true || parameter.in === 'path';
}

function parameterMap(root: JsonObject, pathItem: JsonObject, operation: JsonObject): Map<string, JsonObject> {
  const map = new Map<string, JsonObject>();
  for (const list of [pathItem.parameters, operation.parameters]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const p = resolve(root, raw);
      if (typeof p.in === 'string' && typeof p.name === 'string') {
        map.set(`${p.in}:${p.name}`, p);
      }
    }
  }
  return map;
}

/** Operation-level `security` overrides the document default; '' means none. */
function effectiveSecurity(root: JsonObject, operation: JsonObject): string {
  const declared = Array.isArray(operation.security) ? operation.security
    : Array.isArray(root.security) ? root.security
      : undefined;
  if (!declared) return '';
  return declared.map(entry => valueKey(entry)).sort().join(' ; ');
}

function compareParameters(
  before: Document,
  after: Document,
  oldParameters: Map<string, JsonObject>,
  newParameters: Map<string, JsonObject>,
  where: string,
  report: Reporter,
): void {
  for (const [key, parameter] of newParameters) {
    const previous = oldParameters.get(key);
    if (isRequiredParameter(parameter) && !(previous && isRequiredParameter(previous))) {
      report.breaking('PARAMETER_REQUIRED', `${where} ${key}`, 'Newly required parameter.');
    }
  }
  for (const [key, previous] of oldParameters) {
    const next = newParameters.get(key);
    if (!next) {
      report.breaking('PARAMETER_REMOVED', `${where} ${key}`, 'Previously supported parameter removed.');
      continue;
    }
    const location = `${where} ${key}`;
    if (previous.schema !== undefined && next.schema !== undefined) {
      compareSchema(before, after, previous.schema, next.schema, location, 'request', report, new WeakMap(), 0);
    } else if (previous.schema !== undefined || next.schema !== undefined) {
      report.notice('SCHEMA_NOT_COMPARED', location,
        `A schema is declared on only the ${previous.schema !== undefined ? 'base' : 'head'} side of this parameter; value compatibility was not evaluated.`);
    }
    if (previous.content !== undefined || next.content !== undefined) {
      report.notice('SCHEMA_NOT_COMPARED', location,
        'Parameters serialised with `content` are not evaluated; review this parameter manually.');
    }
  }
}

export function compareSpecifications(oldRoot: JsonObject, newRoot: JsonObject): ComparisonResult {
  const before = documentFor(oldRoot);
  const after = documentFor(newRoot);
  const breaking: Finding[] = [];
  const notices: Finding[] = [];
  const seenFindings = new Set<string>();
  const collect = (target: Finding[]) => (code: string, location: string, message: string) => {
    const id = `${code}|${location}|${message}`;
    if (seenFindings.has(id)) return;
    seenFindings.add(id);
    target.push({ code, location, message });
  };
  const report: Reporter = { breaking: collect(breaking), notice: collect(notices) };

  const oldPaths = record(oldRoot.paths);
  const newPaths = record(newRoot.paths);
  let checkedOperations = 0;

  for (const [route, oldRawPath] of Object.entries(oldPaths)) {
    const oldPath = resolve(oldRoot, oldRawPath);
    const newPath = route in newPaths ? resolve(newRoot, newPaths[route]) : null;
    for (const method of METHODS) {
      const rawOldOp = oldPath[method];
      if (rawOldOp === undefined) continue;
      checkedOperations++;
      const where = `${method.toUpperCase()} ${route}`;
      if (!newPath || newPath[method] === undefined) {
        report.breaking('OPERATION_REMOVED', where, 'Previously available endpoint removed.');
        continue;
      }
      const oldOp = resolve(oldRoot, rawOldOp);
      const newOp = resolve(newRoot, newPath[method]);

      if (effectiveSecurity(oldRoot, oldOp) !== effectiveSecurity(newRoot, newOp)) {
        report.notice('SECURITY_NOT_COMPARED', where,
          'Security requirements changed; authentication compatibility is not evaluated and must be reviewed manually.');
      }

      compareParameters(
        before,
        after,
        parameterMap(oldRoot, oldPath, oldOp),
        parameterMap(newRoot, newPath, newOp),
        where,
        report,
      );

      const oldBody = oldOp.requestBody ? resolve(oldRoot, oldOp.requestBody) : {};
      const newBody = newOp.requestBody ? resolve(newRoot, newOp.requestBody) : {};
      if (newBody.required === true && oldBody.required !== true) {
        report.breaking('REQUEST_BODY_REQUIRED', where, 'Request body is now required.');
      }
      compareContent(before, after, oldBody.content, newBody.content, `${where} request`, 'request', report);

      const oldResponses = record(oldOp.responses);
      const newResponses = record(newOp.responses);
      for (const [status, oldResponse] of Object.entries(oldResponses)) {
        if (!/^2\d\d$/.test(status)) continue;
        if (!(status in newResponses)) {
          report.breaking('SUCCESS_RESPONSE_REMOVED', `${where} ${status}`, 'Previously documented success status removed.');
          continue;
        }
        const previous = resolve(oldRoot, oldResponse);
        const next = resolve(newRoot, newResponses[status]);
        compareContent(before, after, previous.content, next.content, `${where} ${status} response`, 'response', report);
      }
    }
  }

  const byLocation = (a: Finding, b: Finding) =>
    a.location.localeCompare(b.location) || a.code.localeCompare(b.code);
  breaking.sort(byLocation);
  notices.sort(byLocation);
  return { breaking, notices, checkedOperations };
}
