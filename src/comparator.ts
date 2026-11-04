import type { ComparisonResult, Finding, JsonObject } from './types';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Schema keywords whose semantics this rule set cannot evaluate yet. */
const COMPOSITION_KEYWORDS = ['allOf', 'oneOf', 'anyOf', 'not'] as const;

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

function record(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function resolve(root: JsonObject, value: unknown): JsonObject {
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
    for (const segment of ref.slice(2).split('/')) {
      const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
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
function effectiveTypes(schema: JsonObject): Set<string> {
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
function permits(types: Set<string>, type: string): boolean {
  return types.has(type) || (type === 'integer' && types.has('number'));
}

function formatTypes(types: Iterable<string>): string {
  return [...types].sort().join(' | ');
}

function valueKey(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

/** Distinct enum values keyed by their JSON form, or `null` when unconstrained. */
function enumValues(schema: JsonObject): Map<string, unknown> | null {
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) return null;
  const values = new Map<string, unknown>();
  for (const value of schema.enum) values.set(valueKey(value), value);
  return values;
}

function isClosedObject(schema: JsonObject): boolean {
  return schema.additionalProperties === false;
}

const NUMERIC_TYPES = ['number', 'integer'] as const;

/**
 * Whether a validation keyword can affect any instance either side accepts.
 * A keyword only constrains instances of the types it applies to, so comparing
 * `minLength` on a pair of schemas that are both declared `number` would be
 * noise. An undeclared type means any instance is possible, so the keyword can
 * bite; this asks what the keywords constrain and never infers a type.
 */
function constraintApplies(
  oldSchema: JsonObject,
  newSchema: JsonObject,
  applicable: readonly string[],
): boolean {
  const combined = new Set([...effectiveTypes(oldSchema), ...effectiveTypes(newSchema)]);
  if (combined.size === 0) return true;
  return applicable.some(type => combined.has(type));
}

/** One edge of a permitted range. `limit` may be infinite when absent. */
interface Bound {
  limit: number;
  exclusive: boolean;
}

const LOWER_UNBOUNDED: Bound = { limit: -Infinity, exclusive: false };
const UPPER_UNBOUNDED: Bound = { limit: Infinity, exclusive: false };

function isTighterLower(next: Bound, previous: Bound): boolean {
  if (next.limit !== previous.limit) return next.limit > previous.limit;
  return next.exclusive && !previous.exclusive;
}

function isTighterUpper(next: Bound, previous: Bound): boolean {
  if (next.limit !== previous.limit) return next.limit < previous.limit;
  return next.exclusive && !previous.exclusive;
}

function formatLower(bound: Bound): string {
  return bound.limit === -Infinity ? 'unbounded' : `${bound.exclusive ? '>' : '>='} ${bound.limit}`;
}

function formatUpper(bound: Bound): string {
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
 * The effective lower bound, accepting both dialects: OpenAPI 3.0 writes
 * `minimum` with a boolean `exclusiveMinimum`, OpenAPI 3.1 writes a numeric
 * `exclusiveMinimum`. When both appear the stricter one wins.
 */
function numericLowerBound(schema: JsonObject): Bound {
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
  return isIntegerOnly(schema) ? snapLowerToInteger(bound) : bound;
}

function numericUpperBound(schema: JsonObject): Bound {
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
  return isIntegerOnly(schema) ? snapUpperToInteger(bound) : bound;
}

/** An absent `minLength`/`minItems` is the same as zero. */
function countLowerBound(schema: JsonObject, keyword: string): Bound {
  const value = schema[keyword];
  return { limit: typeof value === 'number' ? value : 0, exclusive: false };
}

/** An absent `maxLength`/`maxItems` imposes no upper limit. */
function countUpperBound(schema: JsonObject, keyword: string): Bound {
  const value = schema[keyword];
  return { limit: typeof value === 'number' ? value : Infinity, exclusive: false };
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

/** Flags keywords that are present but not evaluated, so reports stay honest. */
function noteUnevaluatedKeywords(
  oldSchema: JsonObject,
  newSchema: JsonObject,
  location: string,
  report: Reporter,
): void {
  for (const keyword of COMPOSITION_KEYWORDS) {
    if (keyword in oldSchema || keyword in newSchema) {
      report.notice('UNSUPPORTED_COMPOSITION', location,
        `\`${keyword}\` is present but not evaluated; review this subschema manually.`);
    }
  }
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

function compareSchema(
  oldRoot: JsonObject,
  newRoot: JsonObject,
  oldRaw: unknown,
  newRaw: unknown,
  location: string,
  direction: Direction,
  report: Reporter,
  seen: WeakMap<object, WeakSet<object>>,
): void {
  const oldSchema = resolve(oldRoot, oldRaw);
  const newSchema = resolve(newRoot, newRaw);
  const visited = seen.get(oldSchema);
  if (visited?.has(newSchema)) return;
  if (visited) visited.add(newSchema);
  else seen.set(oldSchema, new WeakSet([newSchema]));

  noteUnevaluatedKeywords(oldSchema, newSchema, location, report);
  noteChangedConstraints(oldSchema, newSchema, location, report);
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
      compareSchema(oldRoot, newRoot, oldProperties[name], newProperties[name], `${location}.${name}`, direction, report, seen);
    }
  }

  const oldItems = oldSchema.items;
  const newItems = newSchema.items;
  if (oldItems !== undefined && newItems !== undefined) {
    compareSchema(oldRoot, newRoot, oldItems, newItems, `${location}[]`, direction, report, seen);
  } else if (oldItems !== undefined || newItems !== undefined) {
    report.notice('SCHEMA_NOT_COMPARED', `${location}[]`,
      `Array item schema is declared on only the ${oldItems !== undefined ? 'base' : 'head'} side; element compatibility was not evaluated.`);
  }
}

function compareContent(
  oldRoot: JsonObject,
  newRoot: JsonObject,
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
      compareSchema(oldRoot, newRoot, oldSchema, newSchema, where, direction, report, new WeakMap());
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
  oldRoot: JsonObject,
  newRoot: JsonObject,
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
      compareSchema(oldRoot, newRoot, previous.schema, next.schema, location, 'request', report, new WeakMap());
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
        oldRoot,
        newRoot,
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
      compareContent(oldRoot, newRoot, oldBody.content, newBody.content, `${where} request`, 'request', report);

      const oldResponses = record(oldOp.responses);
      const newResponses = record(newOp.responses);
      for (const [status, oldResponse] of Object.entries(oldResponses)) {
        if (!/^2\d\d$/.test(status)) continue;
        if (!(status in newResponses)) {
          report.breaking('SUCCESS_RESPONSE_REMOVED', `${where} ${status}`, 'Previously documented success status removed.');
          continue;
        }
        const before = resolve(oldRoot, oldResponse);
        const after = resolve(newRoot, newResponses[status]);
        compareContent(oldRoot, newRoot, before.content, after.content, `${where} ${status} response`, 'response', report);
      }
    }
  }

  const byLocation = (a: Finding, b: Finding) =>
    a.location.localeCompare(b.location) || a.code.localeCompare(b.code);
  breaking.sort(byLocation);
  notices.sort(byLocation);
  return { breaking, notices, checkedOperations };
}
