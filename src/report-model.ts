import type { Finding } from './types';

/** One side of the comparison, as far as the caller knows it. */
export interface ComparedSide {
  /** The specification path, as the caller identifies it. */
  path: string;
  /** The Git commit the side was read from, or `null` when it came from a plain file. */
  revision: string | null;
}

/**
 * What the report says about where the comparison came from. Nothing here
 * influences a verdict; it is metadata carried into the machine-readable
 * formats.
 */
export interface ReportContext {
  baseline: ComparedSide | null;
  head: ComparedSide | null;
  /**
   * A repository-relative path to attach to SARIF results as a file-level
   * physical location (no region), or `null` for logical locations only. It is
   * set only when every finding is known to concern that one file.
   */
  physicalLocationUri?: string | null;
}

export const EMPTY_CONTEXT: ReportContext = { baseline: null, head: null, physicalLocationUri: null };

/** Code-point order, so the result never depends on the machine's locale. */
function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Findings in a fixed order: location, then rule code, then message. */
export function orderFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) =>
    ordinal(a.location, b.location) || ordinal(a.code, b.code) || ordinal(a.message, b.message));
}

