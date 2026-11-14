import type { JsonObject, Reporter } from './types';
import { record, resolve } from './schema';

/**
 * Scheme types whose requirement semantics are defined by OpenAPI. Anything
 * else is carried through as an opaque definition and never used for a verdict.
 */
const KNOWN_SCHEME_TYPES: ReadonlySet<string> = new Set([
  'apiKey', 'http', 'oauth2', 'openIdConnect', 'mutualTLS',
]);

/**
 * Only for these types is the list in a security requirement a set of scopes
 * that must all be granted. For every other type OpenAPI 3.0 requires the list
 * to be empty and 3.1 allows role names "not otherwise defined", so a changed
 * list there cannot be read as a tightening or a relaxation.
 */
const SCOPED_SCHEME_TYPES: ReadonlySet<string> = new Set(['oauth2', 'openIdConnect']);

/** How many reasons a single notice spells out before summarising the rest. */
const MAX_REASONS = 3;

type SchemeState =
  | { status: 'missing' }
  /** Present but unusable; `raw` only tells whether it changed. */
  | { status: 'unreadable'; reason: string; raw: unknown }
  | { status: 'defined'; type: string; definition: JsonObject };

/** One security requirement object: every listed scheme must be satisfied. */
interface Requirement {
  /** Scheme name → sorted, de-duplicated scope list. */
  schemes: Map<string, string[]>;
  key: string;
}

type ParsedSecurity =
  | { ok: true; alternatives: Requirement[]; key: string }
  | { ok: false; reason: string; key: string };

type Verdict = 'yes' | 'no' | 'unknown';

interface Coverage {
  verdict: Verdict;
  candidate: Requirement;
  /** Schemes the candidate demands that the old credentials provably lack. */
  addedSchemes: string[];
  /** Scopes the candidate demands beyond those the old requirement held. */
  addedScopes: Array<{ scheme: string; scopes: string[] }>;
  /** Why the outcome could not be established, when it could not. */
  reasons: string[];
}

/**
 * Per-run state for one comparison: both documents, memoised scheme lookups,
 * and the schemes that operations name on both sides, so a changed definition
 * is reported once rather than once per operation.
 */
export interface SecurityContext {
  readonly oldRoot: JsonObject;
  readonly newRoot: JsonObject;
  readonly oldSchemes: Map<string, SchemeState>;
  readonly newSchemes: Map<string, SchemeState>;
  readonly definitionChanges: Map<string, string | null>;
  /** Scheme name → operations that require it before and after the change. */
  readonly carriedOver: Map<string, number>;
}

export function securityContext(oldRoot: JsonObject, newRoot: JsonObject): SecurityContext {
  return {
    oldRoot,
    newRoot,
    oldSchemes: new Map(),
    newSchemes: new Map(),
    definitionChanges: new Map(),
    carriedOver: new Map(),
  };
}

/** A key that ignores object key order, so equal values compare equal. */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableKey(object[key])}`).join(',')}}`;
}

function quote(names: Iterable<string>): string {
  return [...names].map(name => `\`${name}\``).join(', ');
}

function lookupScheme(root: JsonObject, name: string): SchemeState {
  const schemes = record(record(root.components).securitySchemes);
  if (!Object.hasOwn(schemes, name)) return { status: 'missing' };
  let definition: JsonObject;
  try {
    definition = resolve(root, schemes[name]);
  } catch {
    // A broken reference here must not abort a comparison that would otherwise
    // succeed; the scheme is simply not usable as evidence.
    return { status: 'unreadable', reason: 'its definition is a reference that could not be resolved', raw: schemes[name] };
  }
  if (typeof definition.type !== 'string') {
    return { status: 'unreadable', reason: 'its definition declares no `type`', raw: definition };
  }
  return { status: 'defined', type: definition.type, definition };
}

function schemeState(cache: Map<string, SchemeState>, root: JsonObject, name: string): SchemeState {
  let state = cache.get(name);
  if (!state) {
    state = lookupScheme(root, name);
    cache.set(name, state);
  }
  return state;
}

function oldScheme(context: SecurityContext, name: string): SchemeState {
  return schemeState(context.oldSchemes, context.oldRoot, name);
}

function newScheme(context: SecurityContext, name: string): SchemeState {
  return schemeState(context.newSchemes, context.newRoot, name);
}

/** The part of a scheme definition a client depends on, minus prose. */
function clientContract(definition: JsonObject): JsonObject {
  const contract: JsonObject = {};
  for (const [key, value] of Object.entries(definition)) {
    if (key === 'description' || key === 'flows') continue;
    // HTTP authentication scheme names are case-insensitive (RFC 9110).
    const caseInsensitive = definition.type === 'http' && key === 'scheme' && typeof value === 'string';
    contract[key] = caseInsensitive ? (value as string).toLowerCase() : value;
  }
  return contract;
}

/**
 * OAuth2 flows are compared directionally: a client relies on the flows and
 * scopes that existed, so a new flow or a new available scope takes nothing
 * away, while a removed flow, a removed scope or a moved endpoint may.
 */
function describeFlowChange(before: unknown, after: unknown): string | null {
  const isFlowMap = (value: unknown) =>
    value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value));
  if (!isFlowMap(before) || !isFlowMap(after)) {
    return stableKey(before) === stableKey(after) ? null : '`flows` changed';
  }
  const oldFlows = record(before);
  const newFlows = record(after);
  for (const name of Object.keys(oldFlows).sort()) {
    if (!Object.hasOwn(newFlows, name)) return `OAuth2 flow \`${name}\` was removed`;
    const oldFlow = record(oldFlows[name]);
    const newFlow = record(newFlows[name]);
    const keys = new Set([...Object.keys(oldFlow), ...Object.keys(newFlow)]);
    keys.delete('scopes');
    for (const key of [...keys].sort()) {
      if (stableKey(oldFlow[key]) !== stableKey(newFlow[key])) {
        return `\`${key}\` of OAuth2 flow \`${name}\` changed`;
      }
    }
    const newScopes = record(newFlow.scopes);
    const removed = Object.keys(record(oldFlow.scopes)).filter(scope => !Object.hasOwn(newScopes, scope)).sort();
    if (removed.length) {
      return `OAuth2 flow \`${name}\` no longer offers ${removed.length === 1 ? 'scope' : 'scopes'} ${quote(removed)}`;
    }
  }
  return null;
}

/**
 * Describes how a scheme's definition differs between the two documents, or
 * returns `null` when the head definition means the same to a client holding
 * credentials for the base one. A name alone is never taken as proof that two
 * definitions describe the same credential.
 */
function describeDefinitionChange(before: SchemeState, after: SchemeState): string | null {
  if (before.status === 'missing' && after.status === 'missing') return null;
  if (before.status === 'missing') return 'it is defined only in the head document';
  if (after.status === 'missing') return 'it is defined only in the base document';
  if (before.status === 'unreadable' || after.status === 'unreadable') {
    // Unusable in the same way on both sides is not a change.
    if (before.status === 'unreadable' && after.status === 'unreadable'
      && stableKey(before.raw) === stableKey(after.raw)) return null;
    return before.status === 'unreadable' ? before.reason : (after as { reason: string }).reason;
  }
  if (before.type !== after.type) return `its type changed (${before.type} → ${after.type})`;
  const oldContract = clientContract(before.definition);
  const newContract = clientContract(after.definition);
  const keys = new Set([...Object.keys(oldContract), ...Object.keys(newContract)]);
  const changed = [...keys].filter(key => stableKey(oldContract[key]) !== stableKey(newContract[key])).sort();
  if (changed.length) return `its definition changed (${quote(changed)})`;
  const flows = describeFlowChange(before.definition.flows, after.definition.flows);
  return flows === null ? null : `its definition changed (${flows})`;
}

function definitionChange(context: SecurityContext, name: string): string | null {
  let change = context.definitionChanges.get(name);
  if (change === undefined) {
    change = describeDefinitionChange(oldScheme(context, name), newScheme(context, name));
    context.definitionChanges.set(name, change);
  }
  return change;
}

/**
 * Whether two definitions describe the same thing on the wire. A request that
 * satisfies one then looks exactly like a request that satisfies the other, so
 * their names alone cannot show that they are different credentials.
 */
function indistinguishable(left: SchemeState, right: SchemeState): boolean {
  return left.status === 'defined' && right.status === 'defined'
    && describeDefinitionChange(left, right) === null
    && describeDefinitionChange(right, left) === null;
}

/**
 * How a scheme authenticates, coarsely, or `null` when that is not known. Two
 * definitions with different mechanisms cannot be the same credential under a
 * new name; two with the same mechanism might be.
 */
function mechanism(state: SchemeState): string | null {
  if (state.status !== 'defined' || !KNOWN_SCHEME_TYPES.has(state.type)) return null;
  if (state.type !== 'http') return state.type;
  const scheme = state.definition.scheme;
  return typeof scheme === 'string' ? `http ${scheme.toLowerCase()}` : null;
}

function requirementKey(schemes: Map<string, string[]>): string {
  return stableKey([...schemes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const ANONYMOUS: Requirement = { schemes: new Map(), key: requirementKey(new Map()) };

/**
 * Reads a `security` array into alternatives. The list is a disjunction, so
 * order and duplicates carry no meaning; an empty list declares no requirement
 * at all and is therefore the same as the single empty requirement `{}`.
 */
function parseSecurity(declared: unknown): ParsedSecurity {
  const malformed = (reason: string): ParsedSecurity => ({ ok: false, reason, key: stableKey(declared) });
  if (!Array.isArray(declared)) return malformed('`security` is not a list');
  const byKey = new Map<string, Requirement>();
  for (const entry of declared) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return malformed('a `security` entry is not a security requirement object');
    }
    const schemes = new Map<string, string[]>();
    for (const [name, scopes] of Object.entries(entry as JsonObject)) {
      if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string')) {
        return malformed(`the scope list of \`${name}\` is not a list of strings`);
      }
      schemes.set(name, [...new Set(scopes as string[])].sort());
    }
    const key = requirementKey(schemes);
    if (!byKey.has(key)) byKey.set(key, { schemes, key });
  }
  if (byKey.size === 0) byKey.set(ANONYMOUS.key, ANONYMOUS);
  const keys = [...byKey.keys()].sort();
  return { ok: true, alternatives: keys.map(key => byKey.get(key)!), key: keys.join(' ; ') };
}

/**
 * The requirements that actually govern an operation: its own `security` when
 * declared — including an explicit empty list, which switches the document
 * default off — and the document-level `security` otherwise.
 */
function effectiveSecurity(root: JsonObject, operation: JsonObject): ParsedSecurity {
  if (operation.security !== undefined) return parseSecurity(operation.security);
  if (root.security !== undefined) return parseSecurity(root.security);
  return parseSecurity([]);
}

function formatRequirement(requirement: Requirement): string {
  if (requirement.schemes.size === 0) return 'no authentication';
  return [...requirement.schemes.keys()].sort()
    .map(name => {
      const scopes = requirement.schemes.get(name)!;
      return scopes.length ? `${name}(${scopes.join(', ')})` : name;
    })
    .join(' + ');
}

function formatAlternatives(alternatives: Requirement[]): string {
  return alternatives.map(formatRequirement).join(' or ');
}

function formatSecurity(security: ParsedSecurity): string {
  return security.ok ? formatAlternatives(security.alternatives) : 'unreadable';
}

function describeUnusable(name: string, state: SchemeState, side: 'base' | 'head'): string {
  if (state.status === 'missing') {
    return `\`${name}\` is not defined under \`components.securitySchemes\` in the ${side} document`;
  }
  if (state.status === 'unreadable') return `\`${name}\` cannot be read in the ${side} document: ${state.reason}`;
  return `\`${name}\` has the unsupported type \`${state.type}\` in the ${side} document`;
}

/**
 * Whether credentials that satisfied `previous` are certain to satisfy
 * `candidate`. `yes` and `no` are only returned when the documents establish
 * it; anything that rests on a scheme whose identity or semantics cannot be
 * pinned down is `unknown`.
 */
function coverage(context: SecurityContext, previous: Requirement, candidate: Requirement): Coverage {
  const result: Coverage = { verdict: 'yes', candidate, addedSchemes: [], addedScopes: [], reasons: [] };
  let refuted = false;
  for (const name of [...candidate.schemes.keys()].sort()) {
    const wanted = candidate.schemes.get(name)!;
    const held = previous.schemes.get(name);
    const after = newScheme(context, name);

    if (held !== undefined) {
      const change = definitionChange(context, name);
      if (change !== null) {
        result.reasons.push(`\`${name}\` may no longer be the same credential: ${change}`);
        continue;
      }
      // An identical entry over an unchanged definition means the same thing on
      // both sides, whatever the scheme is.
      if (stableKey(wanted) === stableKey(held)) continue;
      if (after.status !== 'defined' || !KNOWN_SCHEME_TYPES.has(after.type)) {
        result.reasons.push(describeUnusable(name, after, 'head'));
        continue;
      }
      if (!SCOPED_SCHEME_TYPES.has(after.type)) {
        result.reasons.push(`\`${name}\` is not an OAuth2 or OpenID Connect scheme, so its changed role list has no defined meaning`);
        continue;
      }
      const added = wanted.filter(scope => !held.includes(scope));
      if (added.length) {
        result.addedScopes.push({ scheme: name, scopes: added });
        refuted = true;
      }
      continue;
    }

    // The candidate demands a scheme the old requirement did not involve.
    if (after.status !== 'defined' || !KNOWN_SCHEME_TYPES.has(after.type)) {
      result.reasons.push(describeUnusable(name, after, 'head'));
      continue;
    }
    const heldNames = [...previous.schemes.keys()].sort();
    const double = heldNames.find(other => indistinguishable(oldScheme(context, other), after));
    if (double !== undefined) {
      result.reasons.push(`\`${name}\` is defined exactly like \`${double}\`, so the credentials held for \`${double}\` may satisfy it`);
      continue;
    }
    if (definitionChange(context, name) !== null) {
      // A scheme that is new or redefined in the head document may be one of
      // the old credentials under another name. Only an old scheme that the
      // candidate dropped can have been renamed into it.
      const target = mechanism(after);
      const twin = heldNames.find(other => {
        if (candidate.schemes.has(other)) return false;
        const kind = mechanism(oldScheme(context, other));
        return kind === null || target === null || kind === target;
      });
      if (twin !== undefined) {
        result.reasons.push(`\`${name}\` is new or redefined and may be the credential previously named \`${twin}\``);
        continue;
      }
    }
    result.addedSchemes.push(name);
    refuted = true;
  }
  result.verdict = refuted ? 'no' : result.reasons.length ? 'unknown' : 'yes';
  return result;
}

function gapSize(entry: Coverage): number {
  return entry.addedSchemes.length + entry.addedScopes.reduce((total, gap) => total + gap.scopes.length, 0);
}

/**
 * Ranks a refuted candidate by how closely it continues the old requirement:
 * the same schemes with more scopes first, then the same schemes plus further
 * ones, and last a candidate that swaps schemes out.
 */
function rank(previous: Requirement, entry: Coverage): number {
  if (entry.addedSchemes.length === 0) return 0;
  const keepsEveryScheme = [...previous.schemes.keys()].every(name => entry.candidate.schemes.has(name));
  return keepsEveryScheme ? 1 : 2;
}

function reportUncovered(
  previous: Requirement,
  refuted: Coverage[],
  accepted: string,
  where: string,
  report: Reporter,
): void {
  if (previous.schemes.size === 0) {
    report.breaking('SECURITY_AUTHENTICATION_REQUIRED', where,
      `Authentication is now mandatory (accepted: ${accepted}); unauthenticated requests that were accepted are now rejected.`);
    return;
  }
  const closest = [...refuted].sort((a, b) =>
    rank(previous, a) - rank(previous, b)
    || gapSize(a) - gapSize(b)
    || (a.candidate.key < b.candidate.key ? -1 : a.candidate.key > b.candidate.key ? 1 : 0))[0];
  const transition = `${formatRequirement(previous)} → ${formatRequirement(closest.candidate)}`;
  const scopes = closest.addedScopes
    .map(gap => `${gap.scopes.length === 1 ? 'scope' : 'scopes'} ${quote(gap.scopes)} for \`${gap.scheme}\``)
    .join(' and ');
  const closestRank = rank(previous, closest);
  if (closestRank === 0) {
    report.breaking('SECURITY_SCOPE_REQUIRED', where,
      `Now requires ${scopes} (${transition}); tokens that were sufficient are now rejected.`);
    return;
  }
  if (closestRank === 1) {
    report.breaking('SECURITY_SCHEME_REQUIRED', where,
      `Now also requires ${quote(closest.addedSchemes)}${scopes ? ` and ${scopes}` : ''} (${transition}); credentials that were sufficient are now rejected.`);
    return;
  }
  report.breaking('SECURITY_ALTERNATIVE_REMOVED', where,
    `Authentication alternative ${formatRequirement(previous)} is no longer accepted, and no remaining alternative (${accepted}) is satisfied by the same credentials.`);
}

function summarise(reasons: string[]): string {
  const unique = [...new Set(reasons)].sort();
  const shown = unique.slice(0, MAX_REASONS).join('; ');
  return unique.length > MAX_REASONS ? `${shown}; and ${unique.length - MAX_REASONS} more` : shown;
}

/**
 * Compares the effective security of one operation as an access rule rather
 * than as a list: a change is compatible when every requirement that used to
 * admit a request is still satisfied by at least one alternative, and breaking
 * when the documents establish that one no longer is. Whatever falls between
 * the two is reported for review instead of being decided.
 */
export function compareSecurity(
  context: SecurityContext,
  oldOperation: JsonObject,
  newOperation: JsonObject,
  where: string,
  report: Reporter,
): void {
  const before = effectiveSecurity(context.oldRoot, oldOperation);
  const after = effectiveSecurity(context.newRoot, newOperation);

  if (!before.ok || !after.ok) {
    // An unreadable declaration that did not change cannot affect compatibility.
    if (before.ok === after.ok && before.key === after.key) return;
    const problems = [before, after].flatMap((side, index) =>
      side.ok ? [] : [`${side.reason} in the ${index === 0 ? 'base' : 'head'} document`]);
    report.notice('SECURITY_NOT_COMPARED', where,
      `Security requirements changed (${formatSecurity(before)} → ${formatSecurity(after)}) but could not be read: ${problems.join('; ')}. Review authentication compatibility manually.`);
    return;
  }

  // A scheme named on both sides is relied on across the change, so its
  // definition must be the same one; `reportSchemeChanges` says so when it is
  // not, whatever the verdict on the requirements themselves.
  const named = (alternatives: Requirement[]) =>
    new Set(alternatives.flatMap(requirement => [...requirement.schemes.keys()]));
  const namedAfter = named(after.alternatives);
  for (const name of named(before.alternatives)) {
    if (namedAfter.has(name)) context.carriedOver.set(name, (context.carriedOver.get(name) ?? 0) + 1);
  }
  if (before.key === after.key) return;

  const accepted = formatAlternatives(after.alternatives);
  const undecided: Requirement[] = [];
  const reasons: string[] = [];
  for (const previous of before.alternatives) {
    const outcomes = after.alternatives.map(candidate => coverage(context, previous, candidate));
    if (outcomes.some(outcome => outcome.verdict === 'yes')) continue;
    const unknown = outcomes.filter(outcome => outcome.verdict === 'unknown');
    if (unknown.length) {
      undecided.push(previous);
      for (const outcome of unknown) reasons.push(...outcome.reasons);
      continue;
    }
    // Every alternative is refuted, but that only breaks clients if the
    // credentials they held are themselves understood.
    const unusable = [...previous.schemes.keys()].sort().flatMap(name => {
      const state = oldScheme(context, name);
      return state.status === 'defined' && KNOWN_SCHEME_TYPES.has(state.type)
        ? [] : [describeUnusable(name, state, 'base')];
    });
    if (unusable.length) {
      undecided.push(previous);
      reasons.push(...unusable);
      continue;
    }
    reportUncovered(previous, outcomes, accepted, where, report);
  }

  if (undecided.length) {
    report.notice('SECURITY_NOT_COMPARED', where,
      `Security requirements changed (${formatAlternatives(before.alternatives)} → ${accepted}); whether credentials accepted for ${formatAlternatives(undecided)} still suffice cannot be established: ${summarise(reasons)}. Review authentication compatibility manually.`);
  }
}

/**
 * Reports each scheme whose definition changed underneath operations that keep
 * requiring it. Their requirements can look untouched, yet the credential they
 * ask for may no longer be the one clients hold.
 */
export function reportSchemeChanges(context: SecurityContext, report: Reporter): void {
  for (const name of [...context.carriedOver.keys()].sort()) {
    const change = definitionChange(context, name);
    if (change === null) continue;
    const operations = context.carriedOver.get(name)!;
    report.notice('SECURITY_NOT_COMPARED', `components.securitySchemes.${name}`,
      `Security scheme \`${name}\` is still required by ${operations} operation${operations === 1 ? '' : 's'}, but ${change}; whether existing credentials are still accepted is not evaluated and must be reviewed manually.`);
  }
}
