import type { JsonObject, Reporter } from './types';
import { Document, effectiveTypes, record, resolve, resolveSchema, valueKey } from './schema';
import { flattenAllOf } from './composition';

/**
 * The schema and media type rules, supplied by the comparator so responses and
 * their headers are judged by the same engine as every other schema. Both run
 * in the response direction: the new side may only return less than the old.
 */
export interface ResponseRules {
  schema(
    before: Document, after: Document,
    oldSchema: unknown, newSchema: unknown,
    location: string, report: Reporter,
  ): void;
  content(
    before: Document, after: Document,
    oldContent: unknown, newContent: unknown,
    location: string, report: Reporter,
  ): void;
}

interface Comparison {
  before: Document;
  after: Document;
  rules: ResponseRules;
}

function has(map: JsonObject, key: string): boolean {
  return Object.hasOwn(map, key);
}

// --- Status keys ---------------------------------------------------------------

/**
 * A key of the Responses Object. `family` is the leading digit of a status code
 * or range. Anything that is not a status code, an `nXX` range or `default`
 * has no defined meaning and is never interpreted.
 */
type StatusKey =
  | { kind: 'code'; family: string }
  | { kind: 'range'; family: string }
  | { kind: 'default' }
  | { kind: 'other' };

function classify(key: string): StatusKey {
  if (key === 'default') return { kind: 'default' };
  if (/^[1-5]\d\d$/.test(key)) return { kind: 'code', family: key[0] };
  if (/^[1-5]XX$/.test(key)) return { kind: 'range', family: key[0] };
  return { kind: 'other' };
}

/** The Responses Object without its specification extensions. */
function responseMap(value: unknown): JsonObject {
  const map: JsonObject = {};
  for (const [key, response] of Object.entries(record(value))) {
    if (!key.startsWith('x-')) map[key] = response;
  }
  return map;
}

/**
 * The entry that describes a status once its own key is not declared. OpenAPI
 * gives an explicit code precedence over its range, and `default` describes
 * whatever is not declared otherwise.
 */
function fallbackKey(responses: JsonObject, status: StatusKey): string | null {
  if (status.kind === 'code' && has(responses, `${status.family}XX`)) return `${status.family}XX`;
  if ((status.kind === 'code' || status.kind === 'range') && has(responses, 'default')) return 'default';
  return null;
}

function explicitCodes(responses: JsonObject, family: string): string[] {
  return Object.keys(responses)
    .filter(key => {
      const status = classify(key);
      return status.kind === 'code' && status.family === family;
    })
    .sort();
}

const FAMILY_NAMES: Record<string, string> = {
  1: 'informational', 2: 'success', 3: 'redirection', 4: 'client error', 5: 'server error',
};

// --- Headers ---------------------------------------------------------------------

/** Header Object fields that are evaluated, or that carry no contract meaning. */
const HEADER_FIELDS: ReadonlySet<string> = new Set([
  'description', 'deprecated', 'example', 'examples',
  'required', 'schema', 'content', 'style', 'explode',
]);

interface DeclaredHeader {
  /** The name as written; header names are matched without regard to case. */
  name: string;
  header: JsonObject;
}

interface HeaderSet {
  headers: Map<string, DeclaredHeader>;
  /** Names declared more than once under different capitalisation. */
  ambiguous: Map<string, string>;
}

function headerSet(root: JsonObject, value: unknown): HeaderSet {
  const headers = new Map<string, DeclaredHeader>();
  const ambiguous = new Map<string, string>();
  for (const [name, raw] of Object.entries(record(value))) {
    const key = name.toLowerCase();
    // OpenAPI: a response header named Content-Type is ignored; the media types
    // of `content` describe it.
    if (key === 'content-type') continue;
    const existing = headers.get(key);
    if (existing || ambiguous.has(key)) {
      ambiguous.set(key, existing?.name ?? ambiguous.get(key) ?? name);
      headers.delete(key);
      continue;
    }
    headers.set(key, { name, header: resolve(root, raw) });
  }
  return { headers, ambiguous };
}

/**
 * Whether a header value can be an object, which is the only case where
 * `explode` changes what is sent: `simple` style writes arrays and primitives
 * the same way with or without it.
 */
type ObjectValues = 'possible' | 'impossible' | 'unknown';

const UNDECIDED_KEYWORDS = ['anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'enum', 'const'] as const;

function objectValues(doc: Document, rawSchema: unknown): ObjectValues {
  if (rawSchema === undefined || typeof rawSchema === 'boolean') return 'unknown';
  const flat = flattenAllOf(doc, resolveSchema(doc, rawSchema));
  if (!flat.exact) return 'unknown';
  const types = effectiveTypes(flat.schema);
  if (types.size === 0) return 'unknown';
  if (!types.has('object')) return 'impossible';
  return UNDECIDED_KEYWORDS.some(keyword => keyword in flat.schema) ? 'unknown' : 'possible';
}

function describeValue(value: unknown): string {
  return value === undefined ? 'absent' : valueKey(value);
}

function compareSerialization(
  { before, after }: Comparison,
  previous: JsonObject,
  next: JsonObject,
  location: string,
  report: Reporter,
): void {
  // `simple` is the only style OpenAPI defines for headers, and the default.
  const oldStyle = previous.style ?? 'simple';
  const newStyle = next.style ?? 'simple';
  if (valueKey(oldStyle) !== valueKey(newStyle)) {
    report.notice('HEADER_NOT_COMPARED', location,
      `Header \`style\` changed (${describeValue(previous.style)} → ${describeValue(next.style)}); only \`simple\` is defined for headers, so the effect on the serialised value was not evaluated.`);
  }

  for (const field of Object.keys({ ...previous, ...next }).sort()) {
    if (HEADER_FIELDS.has(field) || field.startsWith('x-') || field === '$ref') continue;
    if (valueKey(previous[field]) === valueKey(next[field])) continue;
    report.notice('HEADER_NOT_COMPARED', location,
      `Header field \`${field}\` changed (${describeValue(previous[field])} → ${describeValue(next[field])}); it is not evaluated for response headers.`);
  }

  const oldExplode = previous.explode ?? false;
  const newExplode = next.explode ?? false;
  if (oldExplode === newExplode) return;
  const change = `${describeValue(previous.explode)} → ${describeValue(next.explode)}`;
  if (typeof oldExplode !== 'boolean' || typeof newExplode !== 'boolean') {
    report.notice('HEADER_NOT_COMPARED', location,
      `Header \`explode\` changed (${change}) and is not a boolean; the serialised value was not evaluated.`);
    return;
  }
  // A schema that does not take part in serialisation (a `content` header, or
  // none at all) is left to the schema and content rules.
  if (previous.schema === undefined || next.schema === undefined) return;
  const now = objectValues(after, next.schema);
  if (now === 'impossible') return;
  const was = objectValues(before, previous.schema);
  if (now === 'possible' && was === 'impossible') return;
  if (now === 'possible' && was === 'possible') {
    report.breaking('RESPONSE_HEADER_SERIALIZATION_CHANGED', location,
      `Header \`explode\` changed (${change}); an object value is now written ${newExplode ? 'as `key=value` pairs instead of alternating keys and values' : 'as alternating keys and values instead of `key=value` pairs'}, which deployed clients parse differently.`);
    return;
  }
  report.notice('HEADER_NOT_COMPARED', location,
    `Header \`explode\` changed (${change}); this alters the serialised value only for objects, and whether this header can carry one could not be established from its schema.`);
}

function compareHeader(
  comparison: Comparison,
  previous: JsonObject,
  next: JsonObject,
  location: string,
  report: Reporter,
): void {
  const { before, after, rules } = comparison;
  if (previous.required === true && next.required !== true) {
    report.breaking('RESPONSE_HEADER_OPTIONAL', location,
      'Previously guaranteed response header is now optional.');
  }

  const oldForm = previous.content !== undefined ? 'content' : previous.schema !== undefined ? 'schema' : null;
  const newForm = next.content !== undefined ? 'content' : next.schema !== undefined ? 'schema' : null;
  if (oldForm !== newForm) {
    if (oldForm === 'content' || newForm === 'content') {
      report.notice('HEADER_NOT_COMPARED', location,
        `Header value is described by ${oldForm ? `\`${oldForm}\`` : 'nothing'} on the base side and by ${newForm ? `\`${newForm}\`` : 'nothing'} on the head side; value compatibility was not evaluated.`);
    } else {
      report.notice('SCHEMA_NOT_COMPARED', location,
        `A schema is declared on only the ${oldForm ? 'base' : 'head'} side of this header; value compatibility was not evaluated.`);
    }
  } else if (oldForm === 'schema') {
    rules.schema(before, after, previous.schema, next.schema, location, report);
  } else if (oldForm === 'content') {
    rules.content(before, after, previous.content, next.content, location, report);
  }

  compareSerialization(comparison, previous, next, location, report);
}

function compareHeaders(
  comparison: Comparison,
  oldHeaders: unknown,
  newHeaders: unknown,
  location: string,
  report: Reporter,
): void {
  const previous = headerSet(comparison.before.root, oldHeaders);
  const next = headerSet(comparison.after.root, newHeaders);

  const ambiguous = new Map([...next.ambiguous, ...previous.ambiguous]);
  for (const [key, name] of ambiguous) {
    report.notice('HEADER_NOT_COMPARED', `${location} header ${name}`,
      'This header is declared more than once under names that differ only in case; header names are case-insensitive, so which declaration applies is ambiguous and it was not compared.');
    previous.headers.delete(key);
    next.headers.delete(key);
  }

  for (const [key, { name, header }] of previous.headers) {
    const where = `${location} header ${name}`;
    const counterpart = next.headers.get(key);
    if (!counterpart) {
      report.breaking('RESPONSE_HEADER_REMOVED', where, header.required === true
        ? 'Previously guaranteed response header removed.'
        : 'Response header removed; clients that read it no longer receive it.');
      continue;
    }
    compareHeader(comparison, header, counterpart.header, where, report);
  }
}

// --- Responses -------------------------------------------------------------------

function compareResponse(
  comparison: Comparison,
  oldResponse: unknown,
  newResponse: unknown,
  location: string,
  report: Reporter,
): void {
  const { before, after, rules } = comparison;
  const previous = resolve(before.root, oldResponse);
  const next = resolve(after.root, newResponse);
  rules.content(before, after, previous.content, next.content, location, report);
  compareHeaders(comparison, previous.headers, next.headers, location, report);
}

/**
 * Compares two responses without reporting, and returns the rule codes the
 * comparison would have raised. An empty list is a proof that everything the
 * old response promised is still promised by the new one.
 */
function differences(
  comparison: Comparison,
  oldResponse: unknown,
  newResponse: unknown,
  location: string,
): string[] {
  const codes = new Set<string>();
  const collect = (code: string) => { codes.add(code); };
  compareResponse(comparison, oldResponse, newResponse, location, { breaking: collect, notice: collect });
  return [...codes].sort();
}

function label(key: string, status: StatusKey): string {
  if (status.kind === 'default') return '`default` response';
  if (status.kind === 'range') return `\`${key}\` response range`;
  return `\`${key}\` response`;
}

function reportRemoved(
  comparison: Comparison,
  key: string,
  oldResponses: JsonObject,
  newResponses: JsonObject,
  where: string,
  report: Reporter,
): void {
  const status = classify(key);
  const location = `${where} ${key}`;
  if (status.kind === 'other') {
    report.notice('RESPONSE_STATUS_REMOVED', location,
      `Response \`${key}\` was removed; the key is not a status code, an \`nXX\` range or \`default\`, so what it described could not be established.`);
    return;
  }
  if (status.kind === 'default') {
    report.notice('RESPONSE_STATUS_REMOVED', location,
      'The `default` response was removed; statuses without a response of their own are no longer documented. Whether they are no longer returned, or returned without documentation, cannot be established.');
    return;
  }

  const fallback = fallbackKey(newResponses, status);
  const remaining = status.kind === 'range' ? explicitCodes(newResponses, status.family) : [];

  if (status.family === '2') {
    if (status.kind === 'range') {
      // Narrowed to explicit codes: each is compared against the range where it
      // is reported as newly declared.
      if (remaining.length === 0) {
        report.breaking('SUCCESS_RESPONSE_REMOVED', location, 'Previously documented success range removed.');
      }
      return;
    }
    if (fallback !== null && fallback !== 'default') {
      const found = differences(comparison, oldResponses[key], newResponses[fallback], `${location} response`);
      if (found.length > 0) {
        report.breaking('SUCCESS_RESPONSE_REMOVED', location,
          `Previously documented success status removed; the \`${fallback}\` range that now describes it does not keep what it promised (${found.join(', ')}).`);
      }
      return;
    }
    report.breaking('SUCCESS_RESPONSE_REMOVED', location, 'Previously documented success status removed.');
    return;
  }

  if (fallback !== null) {
    const found = differences(comparison, oldResponses[key], newResponses[fallback], `${location} response`);
    if (found.length > 0) {
      report.notice('RESPONSE_COVERAGE_CHANGED', location,
        `The ${label(key, status)} was removed, so \`${fallback}\` now describes ${status.kind === 'range' ? 'these statuses' : 'this status'}; it could not be shown to keep what the removed response promised (${found.join(', ')}). Review the two definitions manually.`);
    }
    return;
  }
  const kept = remaining.length > 0 ? ` Only ${remaining.join(', ')} remain documented in this range.` : '';
  report.notice('RESPONSE_STATUS_REMOVED', location,
    `The ${label(key, status)} was removed and no range or \`default\` response covers it.${kept} Whether ${status.kind === 'range' ? 'these statuses are' : 'this status is'} no longer returned, or returned without documentation, cannot be established.`);
}

function reportAdded(
  comparison: Comparison,
  key: string,
  oldResponses: JsonObject,
  newResponses: JsonObject,
  where: string,
  report: Reporter,
): void {
  const status = classify(key);
  const location = `${where} ${key}`;
  if (status.kind === 'other') {
    report.notice('RESPONSE_STATUS_ADDED', location,
      `Response \`${key}\` was added; the key is not a status code, an \`nXX\` range or \`default\`, so what it describes could not be established.`);
    return;
  }
  if (status.kind === 'default') {
    report.notice('RESPONSE_STATUS_ADDED', location,
      'A `default` response was added; statuses without a response of their own are now documented. Whether the operation already returned them, and whether deployed clients handle them, cannot be established.');
    return;
  }

  const fallback = fallbackKey(oldResponses, status);
  if (fallback !== null) {
    const found = differences(comparison, oldResponses[fallback], newResponses[key], `${location} response`);
    if (found.length > 0) {
      report.notice('RESPONSE_COVERAGE_CHANGED', location,
        `The ${label(key, status)} is newly declared; ${status.kind === 'range' ? 'these statuses were' : 'this status was'} described by \`${fallback}\` before, and the new definition could not be shown to keep what that response promised (${found.join(', ')}). Review the two definitions manually.`);
    }
    return;
  }
  const subject = status.kind === 'range' ? 'statuses' : 'status';
  report.notice('RESPONSE_STATUS_ADDED', location,
    `Newly documented ${FAMILY_NAMES[status.family]} ${subject}. Whether the operation already returned ${status.kind === 'range' ? 'them' : 'it'}, and whether deployed clients handle ${status.kind === 'range' ? 'them' : 'it'}, cannot be established.`);
}

/**
 * Compares the responses of one operation.
 *
 * A response declared under the same key on both sides is compared directly:
 * its media types and schemas through the schema engine, and its headers. That
 * holds for every key, so documented error formats are held to the same rules
 * as success bodies.
 *
 * A key present on one side only is never judged from the key alone. The entry
 * that describes the status on the other side is looked up the way OpenAPI
 * defines it (explicit code, then `nXX` range, then `default`) and the two are
 * compared. If nothing the old response promised is lost the change is
 * compatible; otherwise it is reported for review, because the documents cannot
 * say whether the operation really stopped or started returning that status.
 * The one verdict is a success response that is gone with no success range to
 * describe it in its place.
 */
export function compareResponses(
  before: Document,
  after: Document,
  oldOperation: JsonObject,
  newOperation: JsonObject,
  where: string,
  report: Reporter,
  rules: ResponseRules,
): void {
  const comparison: Comparison = { before, after, rules };
  const oldResponses = responseMap(oldOperation.responses);
  const newResponses = responseMap(newOperation.responses);

  for (const key of Object.keys(oldResponses)) {
    if (has(newResponses, key)) {
      compareResponse(comparison, oldResponses[key], newResponses[key], `${where} ${key} response`, report);
    } else {
      reportRemoved(comparison, key, oldResponses, newResponses, where, report);
    }
  }
  for (const key of Object.keys(newResponses)) {
    if (!has(oldResponses, key)) {
      reportAdded(comparison, key, oldResponses, newResponses, where, report);
    }
  }
}
