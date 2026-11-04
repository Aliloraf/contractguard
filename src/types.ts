export type JsonObject = Record<string, unknown>;

export interface Finding {
  code: string;
  location: string;
  message: string;
}

export interface ComparisonResult {
  /** Changes that can break existing clients. These fail the check. */
  breaking: Finding[];
  /**
   * Places where the rule set could not evaluate compatibility, so a clean
   * `breaking` list must not be read as proof of compatibility there.
   */
  notices: Finding[];
  checkedOperations: number;
}
