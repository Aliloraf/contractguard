# Changelog

All notable changes to ContractGuard are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While on `0.x`, a minor
release may change what the engine reports, so workflows should pin an exact release tag.

## [Unreleased]

### Added

**Response header compatibility.** Headers are compared on every response, matched by name
without regard to case, with `$ref`s to `components.headers` resolved on each side and
`Content-Type` ignored as OpenAPI requires. Header schemas go through the existing schema
engine in the response direction, so type, `enum`, range, length, item-count, `allOf` and
`$ref` handling are the same as for bodies, at locations such as
`GET /orders 429 response header Retry-After`. A header described by `content` is compared
through its media type schema.

New breaking rule codes:

- `RESPONSE_HEADER_REMOVED` — a documented response header is gone
- `RESPONSE_HEADER_OPTIONAL` — a `required: true` response header is now optional
- `RESPONSE_HEADER_SERIALIZATION_CHANGED` — `explode` changed on an object-valued header

**Error, range and `default` responses.** Every documented response is now compared, not
only `2xx`. `4xx`/`5xx` codes, `nXX` ranges and `default` are held to the same body and
header rules, reusing the existing codes (`RESPONSE_FIELD_REMOVED`, `SCHEMA_TYPE_CHANGED`,
`MEDIA_TYPE_REMOVED`, …).

**Status keys resolved the way OpenAPI defines them.** A status documented on one side only
is matched to the entry that describes it on the other side — an explicit code, then its
`nXX` range, then `default` — and the two definitions are compared. A change that keeps
every promise (errors consolidated into an identical range, a status split out of `default`
unchanged) is compatible. Anything else is a review notice, never a verdict, because a
document does not say which statuses an operation really returns.

New review notices:

- `RESPONSE_STATUS_ADDED` — a status, range or `default` documented where nothing described
  it before
- `RESPONSE_STATUS_REMOVED` — a non-success status, range or `default` gone with nothing
  left to describe it
- `RESPONSE_COVERAGE_CHANGED` — a status now described by a different entry whose definition
  could not be shown to keep what the old one promised
- `HEADER_NOT_COMPARED` — a header change that is not evaluated: `style`, `explode` on a
  value of unestablished type, a switch between `schema` and `content`, a field outside the
  Header Object, or a name declared twice under different capitalisation

**Directional security requirement analysis.** `security` is now compared as an access rule
instead of being flagged whenever it changed. The engine resolves each operation's effective
requirements — the document default, an operation override, an explicit `security: []` — and
checks that every previously accepted requirement is still satisfied by at least one
alternative, reading the list as alternatives (OR), the schemes in one entry as a
combination (AND), `{}` as optional authentication, and OAuth2 and OpenID Connect scope lists
as required scopes.

New breaking rule codes:

- `SECURITY_AUTHENTICATION_REQUIRED` — an operation that accepted unauthenticated requests
  now requires credentials
- `SECURITY_SCHEME_REQUIRED` — a requirement that used to suffice must now be combined with a
  further scheme
- `SECURITY_SCOPE_REQUIRED` — an OAuth2 or OpenID Connect requirement demands additional
  scopes
- `SECURITY_ALTERNATIVE_REMOVED` — an accepted authentication alternative is gone and no
  remaining alternative is satisfied by the same credentials

Relaxations (security removed, an alternative added, a scope or combined scheme dropped) and
equivalent spellings (reordering, repetition, `[]` versus `[{}]`, a requirement moved between
the document and its operations) are recognised as compatible and reported as nothing.

### Changed

- `SUCCESS_RESPONSE_REMOVED` is no longer raised when a removed `2xx` code is described by a
  `2XX` range that keeps everything it promised. It is now also raised for a removed `2XX`
  range that leaves no success response behind. A `default` response never stands in for a
  removed success response.
- `MEDIA_TYPE_REMOVED`, `SCHEMA_NOT_COMPARED` and the schema rules now also apply to
  non-`2xx` responses and to response headers.
- External or unresolvable `$ref`s inside non-`2xx` responses and response headers are now
  rejected with the same error as anywhere else; previously those parts were never read.
- **Upgrade note:** changes to error responses and response headers that used to go
  unreported can now fail the check, and newly documented or removed statuses now raise
  notices. Exit codes and Action outputs are unchanged in meaning.
- `SECURITY_NOT_COMPARED` is no longer raised for every `security` change. It is kept for
  changes that cannot be decided: a scheme that is undefined, of an unsupported type,
  renamed, or redefined; a changed role list on a scheme without scopes; a malformed
  `security` value. Its message now names the reason.
- A security scheme whose definition changed while operations still require it raises one
  `SECURITY_NOT_COMPARED` notice at `components.securitySchemes.<name>`. Previously such a
  change was not reported at all when the requirements themselves were untouched.
- A `security` value that is not a list is reported rather than skipped in favour of the
  document default.
- **Upgrade note:** security changes that used to produce only a notice can now fail the
  check. Exit codes and Action outputs are unchanged in meaning.

### Known limitations

Media types are matched literally (no ranges, parameters or case folding), response `links`
are not compared, header `style` values other than `simple` are reported rather than
evaluated, and differences found while matching a status to a range or `default` are
summarised in one notice. See the README.

## [0.1.0] - 2026-11-04

First public release.

### Added

**Compatibility engine.** Compares two OpenAPI 3.0 or 3.1 documents, in YAML or JSON, and
reports changes that can break deployed clients. Comparison is directional: a request schema
may only become more permissive, a response schema only more restrictive.

Breaking changes detected, each with a stable rule code and a precise location such as
`GET /orders 200 response [application/json].lines[].price`:

- `OPERATION_REMOVED`, `SUCCESS_RESPONSE_REMOVED`, `MEDIA_TYPE_REMOVED`
- `PARAMETER_REMOVED`, `PARAMETER_REQUIRED` (path parameters count as required even when
  `required: true` is omitted)
- `REQUEST_BODY_REQUIRED`, `REQUEST_FIELD_REQUIRED`, `REQUEST_FIELD_REMOVED`,
  `REQUEST_OBJECT_CLOSED`
- `RESPONSE_FIELD_REMOVED`, `RESPONSE_FIELD_OPTIONAL`
- `SCHEMA_TYPE_CHANGED`, comparing type *sets* rather than type strings, folding OpenAPI 3.0
  `nullable` into the set and treating `integer` as part of `number`
- `REQUEST_ENUM_NARROWED`, `RESPONSE_ENUM_EXPANDED`
- `REQUEST_RANGE_NARROWED` / `RESPONSE_RANGE_WIDENED`,
  `REQUEST_LENGTH_NARROWED` / `RESPONSE_LENGTH_WIDENED`,
  `REQUEST_ITEM_COUNT_NARROWED` / `RESPONSE_ITEM_COUNT_WIDENED`, covering `minimum`,
  `maximum`, both the 3.0 boolean and 3.1 numeric forms of `exclusiveMinimum`/
  `exclusiveMaximum`, `minLength`/`maxLength` and `minItems`/`maxItems`

**Review-required notices.** Anything the rule set cannot evaluate is reported separately
rather than passed over, so a clean result is never mistaken for proof of compatibility.
Notices never fail the check: `UNSUPPORTED_COMPOSITION`, `UNSUPPORTED_TUPLE_ITEMS`,
`CONSTRAINT_NOT_COMPARED`, `SCHEMA_NOT_COMPARED`, `SECURITY_NOT_COMPARED`.

**Schema support.** Internal `$ref` for path items, operations, parameters, bodies, responses
and schemas, including JSON-pointer escapes and recursive schemas; nested objects and array
elements at any depth; `allOf` merged into one effective schema wherever the merge provably
preserves meaning, and abandoned with a reason where it would not — notably when
`additionalProperties` does not govern every declared property; `anyOf` and `oneOf` compared
as whole lists of resolved alternatives, with only provable outcomes reported as verdicts.

**GitHub Action** (`runs.using: node24`, bundled, no install step for consumers). Compares the
specification against `git merge-base <base-sha> HEAD`, which is correct both for GitHub's
default synthetic merge checkout and for a workflow that checks out `head.sha`. Writes the
report to the job summary, sets the `breaking`, `breaking-count` and `notice-count` outputs,
and fails the check on a breaking change. Optional sticky pull request comment, updated in
place on later runs. Clear, actionable errors for a shallow clone, a missing baseline or head
specification, an invalid document, or a non-`pull_request` event; a missing baseline or a
failed Git operation is never reported as compatible.

**CLI.** `npm run cli -- --base <old> --head <new> [--report <file>]`, exiting `0` with no
breaking changes, `1` when breaking changes are found and `2` on invalid input.

### Security

- Git runs through `spawnSync` with an explicit argument list and `shell: false`, so nothing
  in a path, ref or other input can be interpreted as a command.
- `spec-path` must be relative, free of NUL bytes, and resolve inside the repository root as
  Git reports it; commit SHAs from the event payload are format-checked before use.
- External and remote `$ref` pointers are rejected, so resolving a specification makes no
  network requests.
- `pull_request_target` is refused: it grants a writable token to a workflow inspecting
  untrusted changes, and its checkout is the base branch, so the comparison would silently
  pass.
- A pull request comment is only edited when it carries ContractGuard's marker **and** was
  written by the account the configured token acts as. The marker alone is not proof of
  ownership, so a comment the Action cannot show it owns is never modified.
- No baseline fallback: if the common ancestor cannot be found, the run fails with guidance
  instead of measuring against a different commit.

### Known limitations

ContractGuard is deliberately conservative and is **not** a complete OpenAPI compatibility
checker. It does not evaluate external or multi-file `$ref`, `anyOf`/`oneOf` subsumption,
`not`/`if`/`then`/`else`, non-`2xx` responses, response headers, `pattern`, `format`,
`multipleOf`, `uniqueItems`, `minProperties`/`maxProperties`, `servers`, `webhooks`,
`callbacks` or `security` semantics. See the README for the full list and for what each notice
means.

[Unreleased]: https://github.com/Aliloraf/contractguard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Aliloraf/contractguard/releases/tag/v0.1.0
