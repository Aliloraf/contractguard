export type JsonObject = Record<string, unknown>;

export interface Finding {
  code: string;
  location: string;
  message: string;
}

export interface ComparisonResult {
  breaking: Finding[];
  checkedOperations: number;
}
