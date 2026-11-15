/**
 * The catalogue of rule codes the comparison engine can report.
 *
 * It exists for the report formats only: it describes a finding, and never
 * decides one. Whether a change is breaking is settled by the comparison rules,
 * and the formatters take that verdict from which list a finding arrived in.
 * A test fails when a rule code appears in the engine without an entry here.
 */

export type FindingKind = 'breaking' | 'notice';

export interface RuleInfo {
  /** The kind of finding this code produces. */
  kind: FindingKind;
  /** A short label, as a sentence fragment. */
  title: string;
  /** What the rule detects and why it matters. */
  description: string;
}

const breaking = (title: string, description: string): RuleInfo => ({ kind: 'breaking', title, description });
const notice = (title: string, description: string): RuleInfo => ({ kind: 'notice', title, description });

export const RULES: Readonly<Record<string, RuleInfo>> = {
  OPERATION_REMOVED: breaking('Operation removed',
    'A documented path and method is gone, or its whole path is gone. Clients calling it will fail.'),
  SUCCESS_RESPONSE_REMOVED: breaking('Success response removed',
    'A documented 2xx status code or 2XX range is gone from an operation and no remaining success response keeps what it promised.'),
  PARAMETER_REMOVED: breaking('Parameter removed',
    'A path-level or operation-level parameter (identified by its location and name) is gone.'),
  PARAMETER_REQUIRED: breaking('Parameter became required',
    'A parameter that was optional, or is new, is now required, so existing requests omit it.'),
  REQUEST_BODY_REQUIRED: breaking('Request body became required',
    'An operation\'s request body is now required, so existing requests that send none are rejected.'),
  MEDIA_TYPE_REMOVED: breaking('Media type removed',
    'A request or response media type is no longer offered, on any documented response including error, range and default responses.'),
  SCHEMA_TYPE_CHANGED: breaking('Schema type changed incompatibly',
    'A request no longer accepts a type it used to accept, or a response may now return a type it previously could not.'),
  REQUEST_ENUM_NARROWED: breaking('Request enum narrowed',
    'Values were removed from a request-side enum, or an enum was introduced where the value was unconstrained.'),
  RESPONSE_ENUM_EXPANDED: breaking('Response enum expanded',
    'A response enum gained values or lost its enum constraint, so deployed clients may meet values they do not handle.'),
  REQUEST_FIELD_REQUIRED: breaking('Request field became required',
    'A request-side property is newly required, so existing requests that omit it are rejected.'),
  REQUEST_OBJECT_CLOSED: breaking('Request object closed to extra properties',
    'A request object that accepted undeclared properties now sets additionalProperties to false.'),
  REQUEST_RANGE_NARROWED: breaking('Request numeric range narrowed',
    'A request\'s numeric range tightened, so values that were valid are now rejected.'),
  RESPONSE_RANGE_WIDENED: breaking('Response numeric range widened',
    'A response\'s numeric range relaxed, so it may return values outside the previously documented range.'),
  REQUEST_LENGTH_NARROWED: breaking('Request length window narrowed',
    'A request\'s minLength or maxLength window tightened, so strings that were valid are now rejected.'),
  RESPONSE_LENGTH_WIDENED: breaking('Response length guarantee relaxed',
    'A response\'s minLength or maxLength guarantee relaxed, so it may return strings outside the previous window.'),
  REQUEST_ITEM_COUNT_NARROWED: breaking('Request item count narrowed',
    'A request array\'s minItems or maxItems window tightened, so arrays that were valid are now rejected.'),
  RESPONSE_ITEM_COUNT_WIDENED: breaking('Response item count guarantee relaxed',
    'A response array\'s minItems or maxItems guarantee relaxed, so it may return arrays outside the previous window.'),
  REQUEST_FIELD_REMOVED: breaking('Request field removed',
    'A property was dropped from a request schema that does not accept additional properties.'),
  RESPONSE_FIELD_REMOVED: breaking('Response field removed',
    'A response property was removed, in a success or an error body, so clients reading it find nothing.'),
  RESPONSE_FIELD_OPTIONAL: breaking('Response field became optional',
    'A previously guaranteed (required) response property is now optional, so clients may no longer receive it.'),
  RESPONSE_HEADER_REMOVED: breaking('Response header removed',
    'A documented response header is gone. Header names are matched without regard to case.'),
  RESPONSE_HEADER_OPTIONAL: breaking('Response header became optional',
    'A response header that was required is now optional, so clients may no longer receive it.'),
  RESPONSE_HEADER_SERIALIZATION_CHANGED: breaking('Response header serialization changed',
    'The explode setting changed on an object-valued response header, so the value is written differently on the wire.'),
  SECURITY_AUTHENTICATION_REQUIRED: breaking('Authentication now required',
    'An operation that accepted unauthenticated requests now requires credentials.'),
  SECURITY_SCHEME_REQUIRED: breaking('Additional security scheme required',
    'A security requirement that used to suffice must now be combined with a further scheme.'),
  SECURITY_SCOPE_REQUIRED: breaking('Additional scopes required',
    'An OAuth2 or OpenID Connect requirement now demands scopes it did not demand before.'),
  SECURITY_ALTERNATIVE_REMOVED: breaking('Authentication alternative removed',
    'A previously accepted authentication alternative is gone and no remaining alternative is satisfied by the same credentials.'),

  UNSUPPORTED_COMPOSITION: notice('Composed schema not analysed',
    'A composed schema could not be analysed: an allOf that cannot be merged without changing its meaning, or an anyOf/oneOf change whose effect depends on whether the alternatives overlap.'),
  UNSUPPORTED_TUPLE_ITEMS: notice('Tuple validation not analysed',
    'prefixItems (tuple validation) or the array form of items is present and is not evaluated.'),
  SCHEMA_NOT_COMPARED: notice('Schema not compared',
    'A schema is declared on one side only, a parameter uses content serialisation, or a boolean schema changed, so value compatibility was not evaluated.'),
  HEADER_NOT_COMPARED: notice('Response header change not compared',
    'A response header changed in a way that is not evaluated, such as style, explode on a value of unestablished type, or a switch between schema and content.'),
  RESPONSE_STATUS_ADDED: notice('Response status added',
    'A status code, range or default response is documented where nothing described it before. Whether clients handle it cannot be established.'),
  RESPONSE_STATUS_REMOVED: notice('Response status removed',
    'A non-success status code, range or default response is gone and nothing else describes it. It may no longer be returned, or be returned undocumented.'),
  RESPONSE_COVERAGE_CHANGED: notice('Response coverage changed',
    'A status is still documented, but by a different entry whose definition could not be shown to keep what the old one promised.'),
  SECURITY_NOT_COMPARED: notice('Security change not compared',
    'A security change could not be decided because it depends on a scheme that is undefined, unsupported, renamed or redefined, or on a malformed security value.'),
  CONSTRAINT_NOT_COMPARED: notice('Validation constraint not compared',
    'A validation keyword that cannot be evaluated reliably changed, such as pattern, format, multipleOf, const, not or discriminator.'),
};
