# ContractGuard 🛡️

**Catch breaking API changes before they merge.**

ContractGuard compares two OpenAPI 3.0/3.1 documents and reports potentially breaking
changes. It runs locally as a CLI and as a GitHub Action that annotates pull requests
with a Markdown report and fails the check when breaking changes are found.

> **Status: early development.** The rule set is deliberately small, conservative and
> directional. ContractGuard is **not** a complete OpenAPI compatibility checker; a clean
> report is not a guarantee of backward compatibility, and anything the engine cannot
> evaluate is listed explicitly as a review-required notice rather than passed over.

---

## What the comparison engine detects

Comparison is **directional**, which is what keeps the rules precise: a request schema may
only become *more* permissive, and a response schema may only become *more* restrictive.
Adding an optional request field or a new response field is therefore compatible, while the
same change in the opposite direction is reported.

Every finding carries a stable rule code:

| Rule code | Detected change |
| --- | --- |
| `OPERATION_REMOVED` | A documented path + method is gone (or its whole path is gone). |
| `SUCCESS_RESPONSE_REMOVED` | A documented `2xx` status code is gone from an operation. |
| `PARAMETER_REMOVED` | A path-level or operation-level parameter (`in` + `name`) is gone. |
| `PARAMETER_REQUIRED` | A parameter that was optional (or new) is now required. Path parameters count as required even when `required: true` is omitted. |
| `REQUEST_BODY_REQUIRED` | An operation's request body became `required: true`. |
| `MEDIA_TYPE_REMOVED` | A request or `2xx` response media type is no longer offered. |
| `SCHEMA_TYPE_CHANGED` | A request no longer accepts a type it used to, or a response may now return a type it previously could not (`integer` counts as a `number`). Also covers a request gaining, or a response losing, its type constraint. |
| `REQUEST_ENUM_NARROWED` | Values were removed from a request-side `enum`, or an `enum` was introduced where the value was previously unconstrained. |
| `RESPONSE_ENUM_EXPANDED` | A response `enum` gained values, or lost its `enum` constraint entirely — deployed clients may not handle the new values. |
| `REQUEST_FIELD_REQUIRED` | A request-side property (request body or object-typed parameter) became newly required. |
| `REQUEST_OBJECT_CLOSED` | A request object that accepted undeclared properties is now `additionalProperties: false`. |
| `REQUEST_RANGE_NARROWED` | A request's numeric range tightened (`minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`). |
| `RESPONSE_RANGE_WIDENED` | A response's numeric range relaxed, so it may return values outside the documented range. |
| `REQUEST_LENGTH_NARROWED` | A request's `minLength`/`maxLength` window tightened. |
| `RESPONSE_LENGTH_WIDENED` | A response's `minLength`/`maxLength` guarantee relaxed. |
| `REQUEST_ITEM_COUNT_NARROWED` | A request array's `minItems`/`maxItems` window tightened. |
| `RESPONSE_ITEM_COUNT_WIDENED` | A response array's `minItems`/`maxItems` guarantee relaxed. |
| `REQUEST_FIELD_REMOVED` | A property was dropped from a request schema with `additionalProperties: false`. |
| `RESPONSE_FIELD_REMOVED` | A `2xx` response property was removed. |
| `RESPONSE_FIELD_OPTIONAL` | A previously guaranteed (`required`) response property is now optional. |

Rules apply at every depth: nested objects, array elements (reported as `path[]`), parameter
schemas and request/response bodies, with locations such as
`GET /orders 200 response [application/json].items[].price`.

Schema handling details:

- **Type sets are compared, not type strings.** OpenAPI 3.0 `nullable: true` is folded into
  the type set, so `type: string, nullable: true` and 3.1's `type: ['string', 'null']` are
  treated identically. Narrowing `['string','null']` to `string` in a *response* is
  compatible; the same change in a *request* is breaking.
- **`integer` is treated as a subset of `number`.** A request widening `integer` to `number`
  and a response narrowing `number` to `integer` are both compatible; the reverse of either
  is breaking. This holds inside union types too, so `['integer','number']` and `number`
  accept exactly the same values.
- **Structural keywords never imply a type.** `properties`, `required`, `items` and
  `prefixItems` only constrain instances that already are objects or arrays, so a schema
  without `type` is treated as unconstrained and is still compared through its properties
  and items. Adding `type: object` to a request schema that previously declared only
  `properties` therefore *is* breaking — an untyped schema also accepted strings and numbers
  — and a response that drops its declared type may now return anything.
- **Validation constraints are compared as value ranges.** Tightening a request bound and
  relaxing a response bound are both breaking; the reverse of either is compatible. Adding a
  constraint tightens, removing one relaxes, and an absent `minLength`/`minItems` is read as
  `0` while an absent `maxLength`/`maxItems` is read as unbounded, so writing out
  `minLength: 0` is not a change.
- **Both exclusive-bound dialects are understood.** OpenAPI 3.0's boolean
  `exclusiveMinimum: true` alongside `minimum: 5` and OpenAPI 3.1's numeric
  `exclusiveMinimum: 5` are treated as the same bound, so migrating between the two reports
  nothing. When a schema carries both `minimum` and a numeric `exclusiveMinimum`, the
  stricter of the two wins. On an `integer`-only schema an exclusive bound is snapped to the
  equivalent inclusive one, so `exclusiveMinimum: 4` and `minimum: 5` compare equal.
- **A constraint is only compared where it can bite.** Each keyword applies to the instance
  types it constrains, so `minLength` on a pair of schemas both declared `number` is inert
  and ignored. When neither side declares a type, any instance is possible and the keyword is
  compared. This asks what a keyword constrains and never infers a type from it.
- **Internal JSON pointers** (`$ref: '#/components/...'`) are resolved for path items,
  operations, parameters, request bodies, responses and schemas, including the `~0`/`~1`
  escapes, and each side resolves against its own document.
- **Recursive (self-referencing) schemas** terminate via pair-wise cycle tracking.
- YAML and JSON specs are both accepted, with duplicate-key detection in YAML.

## Review-required notices

Silently skipping a construct the engine cannot evaluate would make a clean report
misleading, so those places are reported separately as notices. Notices **do not** fail the
check and **do not** change the CLI exit code; they tell you where a human still has to look.

| Notice code | Meaning |
| --- | --- |
| `UNSUPPORTED_COMPOSITION` | `allOf`, `oneOf`, `anyOf` or `not` is present at a compared position and is not evaluated. |
| `UNSUPPORTED_TUPLE_ITEMS` | `prefixItems` (3.1 tuple validation) is present and is not evaluated. |
| `SCHEMA_NOT_COMPARED` | One side of a pair declares a schema and the other does not (media type, array `items`, parameter), or a parameter uses `content` serialisation. |
| `SECURITY_NOT_COMPARED` | The operation's effective `security` requirements changed; authentication compatibility is not analysed. |
| `CONSTRAINT_NOT_COMPARED` | A validation keyword that cannot be evaluated reliably changed: `pattern`, `format`, `multipleOf`, `uniqueItems`, `contains`/`minContains`/`maxContains`, `minProperties`/`maxProperties`, `patternProperties`, `propertyNames`, `dependentRequired`/`dependentSchemas`, `const`, `readOnly`/`writeOnly`, `unevaluatedProperties`/`unevaluatedItems`, or an `additionalProperties` subschema. Unchanged keywords stay quiet, since they cannot affect compatibility. |

## What the engine does **not** support

- **External or multi-file `$ref`** — any `$ref` that does not start with `#/` is rejected
  with an error (deliberate: it avoids network fetches on untrusted input).
- **`allOf` / `oneOf` / `anyOf` / `not` / `discriminator` semantics** — composition is not
  merged or evaluated. Its presence raises `UNSUPPORTED_COMPOSITION` rather than being
  ignored, but changes *inside* a composed subschema are not compared.
- **`prefixItems` / tuple validation** — flagged via `UNSUPPORTED_TUPLE_ITEMS`, not compared.
- **`security` scheme semantics** — a change is flagged via `SECURITY_NOT_COMPARED`, but
  scopes and scheme types are not analysed.
- **Non-`2xx` responses** — error responses and response headers are not compared.
- **Constraints that need instance-level or language-level reasoning** are not evaluated:
  `pattern` (no regular expression inclusion analysis is attempted), `format`, `multipleOf`,
  `uniqueItems`, `contains`, `minProperties`/`maxProperties`, `patternProperties`,
  `propertyNames`, `dependentRequired`, `const` and `readOnly`/`writeOnly`. A change to any
  of them raises `CONSTRAINT_NOT_COMPARED` instead of being treated as compatible.
- **Annotation keywords** (`default`, `title`, `description`, `example`, `deprecated`) are
  ignored entirely, including for notices.
- **`servers`, `webhooks`, `callbacks`, `links`, `style`/`explode`** and OpenAPI document
  validation in general — ContractGuard only checks that `openapi` is `3.0.x`/`3.1.x` and
  that `paths` is an object.
- **Added paths/operations** are never reported (they are additive by definition).
- **Renamed or newly added spec files** — the Action compares the *same path* across
  commits, so a spec that did not exist at the PR base commit makes the step fail with a
  `git show` error rather than being treated as "no prior contract".
- **Events other than `pull_request`** — the Action exits with an error on `push`,
  `workflow_dispatch`, etc. Use the CLI for those cases.
- **Boolean schemas** (`items: true`, `additionalProperties: true`) are read as
  unconstrained rather than evaluated as JSON Schema booleans.

---

## Local setup

Requirements: **Node.js 24+** and npm (the published Action runs on the `node24` runtime).

```bash
git clone https://github.com/YOUR_USERNAME/contractguard.git
cd contractguard
npm ci            # or: npm install
```

Available scripts:

| Script | Purpose |
| --- | --- |
| `npm test` | Compiles the engine with `tsconfig.core.json`, then runs the `node:test` suite. |
| `npm run typecheck` | Full-project `tsc --noEmit`. |
| `npm run build` | Bundles the Action into `dist/index.js` with `@vercel/ncc`. |
| `npm run cli -- …` | Runs the comparison locally via `tsx`. |

## CLI usage

```bash
npm run cli -- --base <old-spec> --head <new-spec> [--report <file.md>]
```

Example, using the specs committed under `examples/`:

```bash
npm run cli -- --base examples/before.yaml --head examples/after.yaml --report report.md
```

Flags:

- `--base` *(required)* — path to the previous/current contract.
- `--head` *(required)* — path to the proposed contract.
- `--report` *(optional)* — also write the Markdown report to this file.

The report is printed to stdout. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | No breaking changes found by the current rule set (review-required notices do not change this). |
| `1` | At least one potentially breaking change found. |
| `2` | Invalid usage, unreadable file, or an unsupported/invalid specification. |

To compare two git revisions by hand:

```bash
git show main:openapi.yaml > /tmp/base.yaml
npm run cli -- --base /tmp/base.yaml --head openapi.yaml
```

---

## GitHub Action

The Action is a bundled JavaScript action (`runs.using: node24`, entry point
`dist/index.js`). `dist/index.js` is **committed to the repository** so consumers never
have to install dependencies; run `npm run build` and commit the result whenever `src/`
or a dependency changes. CI fails if the committed bundle is stale.

### Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `spec-path` | yes | — | Repository-relative path to the OpenAPI YAML/JSON document. Absolute paths and paths outside the checkout are rejected. |
| `comment` | no | `false` | Post (or update) a sticky pull request comment with the report. |
| `github-token` | no | — | Token used for commenting; required when `comment` is `true`. |

### Outputs

| Output | Description |
| --- | --- |
| `breaking-count` | Number of detected breaking changes. |
| `breaking` | `true` / `false` — whether any breaking change was detected. |

The step fails when at least one breaking change is detected, and the report is always
written to the job summary.

### Example workflow

```yaml
name: API compatibility
on:
  pull_request:
    paths:
      - 'openapi.yaml'
permissions:
  contents: read
  pull-requests: write # only needed when comment: 'true'
jobs:
  compatibility:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # required: the base commit must be available locally
      - uses: YOUR_USERNAME/contractguard@v1
        with:
          spec-path: openapi.yaml
          comment: 'true'
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

`fetch-depth: 0` (or any depth that includes the PR base commit) is required, because the
Action reads the previous contract with `git show <base-sha>:<spec-path>`.

For pull requests from forks, `GITHUB_TOKEN` is read-only: ContractGuard still writes the
job summary and fails the check, and commenting is skipped with a warning.
**Do not switch to `pull_request_target` just to gain comment permissions.**

---

## Security notes

- Specifications from pull requests are treated as **data**, never code. ContractGuard
  does not execute anything from the changed repository.
- Remote/external `$ref` pointers are rejected, so no network requests are made while
  resolving a specification.
- `spec-path` is constrained to the checked-out workspace.
- Prefer `pull_request` over the privileged `pull_request_target` event for untrusted
  changes.

## Roadmap

1. **v0.1** — comparison engine, CLI, bundled GitHub Action, unit tests *(done)*.
2. **v0.2** — directional type/enum rules, `additionalProperties` and array/nested coverage,
   explicit review-required notices *(current)*; still to come: `allOf`/`oneOf`/`anyOf`
   evaluation, numeric/string constraints, broader third-party fixtures.
3. **v0.3** — inline PR annotations, ignore/config rules, JSON diff export, multi-file `$ref`.
4. **v1.0** — full compatibility suite, published versioned Action, example repositories.

## License

MIT — see [LICENSE](LICENSE).
