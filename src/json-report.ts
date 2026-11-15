import { orderFindings } from './report-model';
import type { ComparedSide, ReportContext } from './report-model';
import { RULES } from './rules';
import type { FindingKind } from './rules';
import { TOOL_NAME, TOOL_URI, TOOL_VERSION } from './version';
import type { ComparisonResult, Finding } from './types';

/** Bumped when a field is removed or changes meaning; adding a field does not bump it. */
export const JSON_REPORT_SCHEMA_VERSION = '1.0';

export type Severity = 'error' | 'warning';

export const SEVERITY: Readonly<Record<FindingKind, Severity>> = { breaking: 'error', notice: 'warning' };

export interface JsonFinding {
  code: string;
  severity: Severity;
  location: string;
  message: string;
}

export interface JsonRule {
  code: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  description: string;
}

export interface JsonReport {
  schemaVersion: string;
  tool: { name: string; version: string; informationUri: string };
  comparison: { baseline: ComparedSide | null; head: ComparedSide | null };
  summary: {
    status: 'compatible' | 'breaking';
    breaking: number;
    notices: number;
    checkedOperations: number;
  };
  breaking: JsonFinding[];
  notices: JsonFinding[];
  /** The rules that produced at least one finding, ordered by code. */
  rules: JsonRule[];
}

function side(value: ComparedSide | null): ComparedSide | null {
  return value === null ? null : { path: value.path, revision: value.revision };
}

function findings(list: readonly Finding[], kind: FindingKind): JsonFinding[] {
  return orderFindings(list).map(finding => ({
    code: finding.code,
    severity: SEVERITY[kind],
    location: finding.location,
    message: finding.message,
  }));
}

/** Describes a code, including one this catalogue does not know yet. */
export function describeRule(code: string, kind: FindingKind): JsonRule {
  const known = RULES[code];
  return {
    code,
    kind,
    severity: SEVERITY[kind],
    title: known ? known.title : code,
    description: known ? known.description : `Reported by the ${TOOL_NAME} rule ${code}.`,
  };
}

/** The report as a plain object, with a fixed key order. */
export function buildJsonReport(result: ComparisonResult, context: ReportContext): JsonReport {
  const used = new Map<string, FindingKind>();
  for (const finding of result.notices) used.set(finding.code, 'notice');
  // A breaking finding wins if a code were ever reported as both.
  for (const finding of result.breaking) used.set(finding.code, 'breaking');
  const rules = [...used.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, kind]) => describeRule(code, kind));
  return {
    schemaVersion: JSON_REPORT_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION, informationUri: TOOL_URI },
    comparison: { baseline: side(context.baseline), head: side(context.head) },
    summary: {
      status: result.breaking.length > 0 ? 'breaking' : 'compatible',
      breaking: result.breaking.length,
      notices: result.notices.length,
      checkedOperations: result.checkedOperations,
    },
    breaking: findings(result.breaking, 'breaking'),
    notices: findings(result.notices, 'notice'),
    rules,
  };
}

/** Two-space indented JSON with a trailing newline; identical input gives identical bytes. */
export function renderJson(result: ComparisonResult, context: ReportContext): string {
  return `${JSON.stringify(buildJsonReport(result, context), null, 2)}\n`;
}
