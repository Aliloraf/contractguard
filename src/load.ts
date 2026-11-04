import { parse } from 'yaml';
import type { JsonObject } from './types';

export function loadSpecification(content: string): JsonObject {
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
  return spec;
}
