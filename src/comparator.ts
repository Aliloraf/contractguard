import type { ComparisonResult, Finding, JsonObject } from './types';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

function record(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function entries(value: unknown): [string, unknown][] {
  return Object.entries(record(value));
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

function normalizedType(schema: JsonObject): string {
  const kind = schema.type;
  if (Array.isArray(kind)) return kind.map(String).sort().join('|');
  if (typeof kind === 'string') return kind;
  return '';
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

function changedType(oldSchema: JsonObject, newSchema: JsonObject): boolean {
  const before = normalizedType(oldSchema);
  const after = normalizedType(newSchema);
  return before !== '' && after !== '' && before !== after;
}

function compareSchema(
  oldRoot: JsonObject,
  newRoot: JsonObject,
  oldRaw: unknown,
  newRaw: unknown,
  location: string,
  direction: 'request' | 'response',
  add: (code: string, location: string, message: string) => void,
  seen: WeakMap<object, WeakSet<object>>,
): void {
  const oldSchema = resolve(oldRoot, oldRaw);
  const newSchema = resolve(newRoot, newRaw);
  const visited = seen.get(oldSchema);
  if (visited?.has(newSchema)) return;
  if (visited) visited.add(newSchema);
  else seen.set(oldSchema, new WeakSet([newSchema]));

  if (changedType(oldSchema, newSchema)) {
    add('SCHEMA_TYPE_CHANGED', location, `Type changed (${normalizedType(oldSchema)} → ${normalizedType(newSchema)}).`);
  }

  const oldEnum = Array.isArray(oldSchema.enum) ? oldSchema.enum : [];
  const newEnum = Array.isArray(newSchema.enum) ? newSchema.enum : [];
  if (oldEnum.length && newEnum.length && direction === 'request') {
    const newKeys = new Set(newEnum.map(value => JSON.stringify(value)));
    const removed = oldEnum.filter(value => !newKeys.has(JSON.stringify(value)));
    if (removed.length) add('REQUEST_ENUM_NARROWED', location, `Previously allowed values removed: ${removed.map(value => JSON.stringify(value)).join(', ')}.`);
  }

  const oldProperties = record(oldSchema.properties);
  const newProperties = record(newSchema.properties);
  const oldRequired = new Set(strings(oldSchema.required));
  const newRequired = new Set(strings(newSchema.required));

  if (direction === 'request') {
    for (const name of newRequired) {
      if (!oldRequired.has(name)) {
        add('REQUEST_FIELD_REQUIRED', `${location}.${name}`, 'Field is now required.');
      }
    }
    for (const name of Object.keys(oldProperties)) {
      if (!(name in newProperties) && newSchema.additionalProperties === false) {
        add('REQUEST_FIELD_REMOVED', `${location}.${name}`, 'Previously accepted field removed from a closed object schema.');
      }
    }
  } else {
    for (const name of Object.keys(oldProperties)) {
      if (!(name in newProperties)) {
        add('RESPONSE_FIELD_REMOVED', `${location}.${name}`, 'Response field removed.');
      } else if (oldRequired.has(name) && !newRequired.has(name)) {
        add('RESPONSE_FIELD_OPTIONAL', `${location}.${name}`, 'Previously guaranteed response field is now optional.');
      }
    }
  }

  for (const name of Object.keys(oldProperties)) {
    if (name in newProperties) {
      compareSchema(oldRoot, newRoot, oldProperties[name], newProperties[name], `${location}.${name}`, direction, add, seen);
    }
  }
  if (oldSchema.items && newSchema.items) {
    compareSchema(oldRoot, newRoot, oldSchema.items, newSchema.items, `${location}[]`, direction, add, seen);
  }
}

function compareContent(
  oldRoot: JsonObject,
  newRoot: JsonObject,
  oldContent: unknown,
  newContent: unknown,
  location: string,
  direction: 'request' | 'response',
  add: (code: string, location: string, message: string) => void,
): void {
  const oldTypes = record(oldContent);
  const newTypes = record(newContent);
  for (const [mediaType, rawOld] of Object.entries(oldTypes)) {
    const where = `${location} [${mediaType}]`;
    if (!(mediaType in newTypes)) {
      add('MEDIA_TYPE_REMOVED', where, `${direction === 'request' ? 'Accepted request' : 'Produced response'} media type removed.`);
      continue;
    }
    const oldSchema = record(rawOld).schema;
    const newSchema = record(newTypes[mediaType]).schema;
    if (oldSchema && newSchema) {
      compareSchema(oldRoot, newRoot, oldSchema, newSchema, where, direction, add, new WeakMap());
    }
  }
}

export function compareSpecifications(oldRoot: JsonObject, newRoot: JsonObject): ComparisonResult {
  const findings: Finding[] = [];
  const unique = new Set<string>();
  const add = (code: string, location: string, message: string) => {
    const id = `${code}|${location}|${message}`;
    if (unique.has(id)) return;
    unique.add(id);
    findings.push({ code, location, message });
  };
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
        add('OPERATION_REMOVED', where, 'Previously available endpoint removed.');
        continue;
      }
      const oldOp = resolve(oldRoot, rawOldOp);
      const newOp = resolve(newRoot, newPath[method]);
      const oldParameters = parameterMap(oldRoot, oldPath, oldOp);
      const newParameters = parameterMap(newRoot, newPath, newOp);
      for (const [key, parameter] of newParameters) {
        if (parameter.required === true && oldParameters.get(key)?.required !== true) {
          add('PARAMETER_REQUIRED', `${where} ${key}`, 'Newly required parameter.');
        }
      }
      for (const [key, previous] of oldParameters) {
        const next = newParameters.get(key);
        if (!next) {
          add('PARAMETER_REMOVED', `${where} ${key}`, 'Previously supported parameter removed.');
          continue;
        }
        if (previous.schema && next.schema) {
          compareSchema(oldRoot, newRoot, previous.schema, next.schema, `${where} ${key}`, 'request', add, new WeakMap());
        }
      }

      const oldBody = oldOp.requestBody ? resolve(oldRoot, oldOp.requestBody) : {};
      const newBody = newOp.requestBody ? resolve(newRoot, newOp.requestBody) : {};
      if (newBody.required === true && oldBody.required !== true) {
        add('REQUEST_BODY_REQUIRED', where, 'Request body is now required.');
      }
      compareContent(oldRoot, newRoot, oldBody.content, newBody.content, `${where} request`, 'request', add);

      const oldResponses = record(oldOp.responses);
      const newResponses = record(newOp.responses);
      for (const [status, oldResponse] of Object.entries(oldResponses)) {
        if (!/^2\d\d$/.test(status)) continue;
        if (!(status in newResponses)) {
          add('SUCCESS_RESPONSE_REMOVED', `${where} ${status}`, 'Previously documented success status removed.');
          continue;
        }
        const before = resolve(oldRoot, oldResponse);
        const after = resolve(newRoot, newResponses[status]);
        compareContent(oldRoot, newRoot, before.content, after.content, `${where} ${status} response`, 'response', add);
      }
    }
  }

  findings.sort((a, b) => a.location.localeCompare(b.location) || a.code.localeCompare(b.code));
  return { breaking: findings, checkedOperations };
}
