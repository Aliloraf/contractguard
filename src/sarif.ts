import { createHash } from 'node:crypto';
import { SEVERITY, describeRule } from './json-report';
import { orderFindings } from './report-model';
import type { ReportContext } from './report-model';
import { RULES } from './rules';
import type { FindingKind } from './rules';
import { TOOL_NAME, TOOL_URI, TOOL_VERSION } from './version';
import type { ComparisonResult, Finding } from './types';

export const SARIF_VERSION = '2.1.0';
export const SARIF_SCHEMA = 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json';

/** Where each kind of rule is documented. */
const HELP_URI: Readonly<Record<FindingKind, string>> = {
  breaking: `${TOOL_URI}#what-the-comparison-engine-detects`,
  notice: `${TOOL_URI}#review-required-notices`,
};

const HELP: Readonly<Record<FindingKind, string>> = {
  breaking: 'Clients built against the previous contract can break. Make the change backward compatible, '
    + 'or release it as a new API version.',
  notice: 'ContractGuard could not decide whether this change is compatible. Review it manually; '
    + 'this does not fail the compatibility check.',
};

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string };
  helpUri: string;
  defaultConfiguration: { level: 'error' | 'warning' };
  properties: { tags: string[] };
}

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: 'error' | 'warning';
  message: { text: string };
  locations: Array<{
    physicalLocation?: { artifactLocation: { uri: string } };
    logicalLocations: Array<{ name: string; fullyQualifiedName: string; kind: string }>;
  }>;
  partialFingerprints: Record<string, string>;
  properties: { kind: FindingKind };
}

/** `OPERATION_REMOVED` becomes `OperationRemoved`. */
function pascalCase(code: string): string {
  return code.toLowerCase().split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
}

function buildRule(code: string, kind: FindingKind): SarifRule {
  const info = describeRule(code, kind);
  return {
    id: code,
    name: pascalCase(code),
    shortDescription: { text: info.title },
    fullDescription: { text: info.description },
    help: { text: `${info.description} ${HELP[kind]}` },
    helpUri: HELP_URI[kind],
    defaultConfiguration: { level: SEVERITY[kind] },
    properties: { tags: ['api-compatibility', kind === 'breaking' ? 'breaking-change' : 'review-required'] },
  };
}

/**
 * A stable identity for a finding, so a consumer such as Code Scanning can
 * recognise the same finding on a later run. It is derived from the finding
 * alone, so it does not depend on line numbers that ContractGuard cannot know.
 */
function fingerprint(finding: Finding): string {
  return createHash('sha256').update(`${finding.code}\n${finding.location}\n${finding.message}`).digest('hex');
}

/**
 * Builds a SARIF 2.1.0 log.
 *
 * ContractGuard compares documents semantically and has no source coordinates
 * for a finding, so every result carries a logical location (the operation,
 * status and schema path it concerns). A physical location is added only when
 * the caller states one that is true of every finding, and then only at file
 * granularity: a file with no region. No line or column is ever produced.
 */
export function buildSarif(result: ComparisonResult, context: ReportContext): Record<string, unknown> {
  // Every known rule is listed, in code order, so rule indexes do not depend on
  // which findings a run happened to produce.
  const kinds = new Map<string, FindingKind>();
  for (const [code, info] of Object.entries(RULES)) kinds.set(code, info.kind);
  for (const finding of result.notices) if (!kinds.has(finding.code)) kinds.set(finding.code, 'notice');
  for (const finding of result.breaking) if (!kinds.has(finding.code)) kinds.set(finding.code, 'breaking');
  const codes = [...kinds.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const indexOf = new Map(codes.map((code, index) => [code, index] as const));
  const rules = codes.map(code => buildRule(code, kinds.get(code) as FindingKind));

  const toResult = (finding: Finding, kind: FindingKind): SarifResult => {
    const location: SarifResult['locations'][number] = {
      logicalLocations: [{ name: finding.location, fullyQualifiedName: finding.location, kind: 'resource' }],
    };
    if (context.physicalLocationUri) {
      location.physicalLocation = { artifactLocation: { uri: context.physicalLocationUri } };
    }
    return {
      ruleId: finding.code,
      ruleIndex: indexOf.get(finding.code) as number,
      level: SEVERITY[kind],
      message: { text: `${finding.location}: ${finding.message}` },
      locations: [location],
      partialFingerprints: { 'contractguard/v1': fingerprint(finding) },
      properties: { kind },
    };
  };

  const results = [
    ...orderFindings(result.breaking).map(finding => toResult(finding, 'breaking')),
    ...orderFindings(result.notices).map(finding => toResult(finding, 'notice')),
  ];

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [{
      tool: {
        driver: {
          name: TOOL_NAME,
          version: TOOL_VERSION,
          semanticVersion: TOOL_VERSION,
          informationUri: TOOL_URI,
          rules,
        },
      },
      // The tool ran to completion whether or not it found breaking changes.
      invocations: [{ executionSuccessful: true }],
      results,
      properties: {
        checkedOperations: result.checkedOperations,
        baseline: context.baseline,
        head: context.head,
      },
    }],
  };
}

export function renderSarif(result: ComparisonResult, context: ReportContext): string {
  return `${JSON.stringify(buildSarif(result, context), null, 2)}\n`;
}
