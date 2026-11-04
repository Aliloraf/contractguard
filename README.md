# ContractGuard 🛡️

**Catch breaking API changes before they merge.**

ContractGuard compares two OpenAPI 3.0/3.1 documents and reports potentially breaking
changes. It runs locally as a CLI and as a GitHub Action that annotates pull requests
with a Markdown report and fails the check when breaking changes are found.

> **Status: v0.1 (MVP).** The rule set is deliberately small and conservative.
> ContractGuard is **not** a complete OpenAPI compatibility checker, and a clean report
> is not a guarantee of backward compatibility.

---

## What the MVP detects

Every finding is reported with a stable rule code:

| Rule code | Detected change |
| --- | --- |
| `OPERATION_REMOVED` | A documented path + method is gone (or its whole path is gone). |
| `SUCCESS_RESPONSE_REMOVED` | A documented `2xx` status code is gone from an operation. |
| `PARAMETER_REMOVED` | A path-level or operation-level parameter (`in` + `name`) is gone. |
| `PARAMETER_REQUIRED` | A parameter that was optional (or new) is now `required: true`. |
| `REQUEST_BODY_REQUIRED` | An operation's request body became `required: true`. |
| `MEDIA_TYPE_REMOVED` | A request or `2xx` response media type is no longer offered. |
| `SCHEMA_TYPE_CHANGED` | A schema's `type` changed (nested objects and array `items` included). |
| `REQUEST_ENUM_NARROWED` | Values were removed from a request-side `enum` (parameter or request body schema). |
| `REQUEST_FIELD_REQUIRED` | A request-side property (request body or object-typed parameter) became newly required. |
| `REQUEST_FIELD_REMOVED` | A property was dropped from a request schema with `additionalProperties: false`. |
| `RESPONSE_FIELD_REMOVED` | A `2xx` response property was removed. |
| `RESPONSE_FIELD_OPTIONAL` | A previously guaranteed (`required`) response property is now optional. |

Comparison is **directional**: a newly required *request* field is breaking, while a newly
added *response* field is not. Type changes are flagged in both directions.

Also supported:

- Internal JSON pointers (`$ref: '#/components/...'`) for path items, operations,
  parameters, request bodies, responses and schemas, including JSON-pointer escapes
  (`~0`, `~1`).
- Recursive (self-referencing) schemas, via cycle tracking during the walk.
- YAML and JSON specs, with duplicate-key detection in YAML.

## What the MVP does **not** support

- **External or multi-file `$ref`** — any `$ref` that does not start with `#/` is rejected
  with an error (deliberate: it avoids network fetches on untrusted input).
- **`allOf` / `oneOf` / `anyOf` / `not` / `discriminator`** — composition keywords are not
  merged or compared, so changes inside them are invisible to the current rules.
- **Non-`2xx` responses** — error responses and response headers are not compared.
- **Schema constraints** beyond `type`, `required`, `properties`, `items` and request-side
  `enum`: `format`, `pattern`, `minimum`/`maximum`, `minLength`, `nullable`,
  `additionalProperties` schemas, `readOnly`/`writeOnly` and defaults are ignored.
- **`security`, `servers`, `webhooks`, `callbacks`, `links`, `parameter.content`,
  `style`/`explode`** and OpenAPI document validation in general — ContractGuard only
  checks that `openapi` is `3.0.x`/`3.1.x` and that `paths` is an object.
- **Added paths/operations** are never reported (they are additive by definition).
- **Renamed or newly added spec files** — the Action compares the *same path* across
  commits, so a spec that did not exist at the PR base commit makes the step fail with a
  `git show` error rather than being treated as "no prior contract".
- **Events other than `pull_request`** — the Action exits with an error on `push`,
  `workflow_dispatch`, etc. Use the CLI for those cases.
- **JSON Schema 2020-12 semantics** are only partially honoured (`type` arrays are
  normalised, nothing more).

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
| `0` | No breaking changes found by the current rule set. |
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

1. **v0.1** — comparison engine, CLI, bundled GitHub Action, unit tests *(current)*.
2. **v0.2** — `allOf`/`oneOf`/`anyOf` handling, more schema constraints, broader fixtures.
3. **v0.3** — inline PR annotations, ignore/config rules, JSON diff export, multi-file `$ref`.
4. **v1.0** — full compatibility suite, published versioned Action, example repositories.

## License

MIT — see [LICENSE](LICENSE).
