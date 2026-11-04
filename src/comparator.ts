import type { ComparisonResult, Finding, JsonObject } from './types';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Schema keywords whose semantics this rule set cannot evaluate yet. */
const COMPOSITION_KEYWORDS = ['allOf', 'oneOf', 'anyOf', 'not'] as const;

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

/**
 * Whether `additionalProperties` can matter here at all. This only gates
 * reporting; it makes no claim about the instance type.
 */
function constrainsObjectProperties(schema: JsonObject): boolean {
  return effectiveTypes(schema).has('object') || Object.keys(record(schema.properties)).length > 0;
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
  compareTypes(oldSchema, newSchema, location, direction, report);
  compareEnums(oldSchema, newSchema, location, direction, report);

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
      && (constrainsObjectProperties(oldSchema) || constrainsObjectProperties(newSchema))) {
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
