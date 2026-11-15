import { parse } from 'yaml';
import { DocumentSource, foldReferences } from './references';
import type { JsonObject } from './types';

/** Where a document lives, so the files it references can be found. */
export interface ReferenceContext {
  /** The document's path inside the source's boundary, with `/` separators. */
  path: string;
  source: DocumentSource;
}

/**
 * Parses and validates one OpenAPI document. When a context is given, every
 * local file the document references is loaded from the same source and folded
 * into the result, with each reference resolved relative to the file that
 * contains it. Without one, only internal references can be followed.
 */
export function loadSpecification(content: string, references?: ReferenceContext): JsonObject {
  const result: unknown = parse(content, { uniqueKeys: true });
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Expected an OpenAPI document object.');
  }
  const spec = result as JsonObject;
  if (typeof spec.openapi !== 'string' || !/^3\.[01]\./.test(spec.openapi)) {
    throw new Error('ContractGuard MVP supports OpenAPI 3.0 and 3.1 documents only.');
  }
  if (!spec.paths || typeof spec.paths !== 'object' || Array.isArray(spec.paths)) {
    throw new Error('OpenAPI document must contain a paths object.');
  }
  return references ? foldReferences(spec, references.path, references.source) : spec;
}
