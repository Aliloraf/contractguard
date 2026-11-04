# Changelog

All notable changes to ContractGuard are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While on `0.x`, a minor
release may change what the engine reports, so workflows should pin an exact release tag.

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

[0.1.0]: https://github.com/Aliloraf/contractguard/releases/tag/v0.1.0
