# ContractGuard

**Catch breaking API changes before they merge.**

ContractGuard compares two OpenAPI 3.0/3.1 documents and reports potentially breaking
changes. It runs locally as a CLI and as a GitHub Action that annotates pull requests
with a Markdown report and fails the check when breaking changes are found.

> **Status: early development.** The rule set is deliberately small, conservative and
> directional. ContractGuard is **not** a complete OpenAPI compatibility checker; a clean
> report is not a guarantee of backward compatibility, and anything the engine cannot
> evaluate is listed explicitly as a review-required notice rather than passed over.

---

## Quick start

Add this workflow, replacing `openapi.yaml` with the path to your specification:

```yaml
# .github/workflows/api-compatibility.yml
name: API compatibility
on: pull_request
permissions:
  contents: read
jobs:
  compatibility:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # required: the base commit must be readable locally
      - uses: Aliloraf/contractguard@v0.1.0
        with:
          spec-path: openapi.yaml
```

On every pull request that touches the specification, ContractGuard compares it against the
base branch and writes a report to the job summary. The check **fails** when it finds a
breaking change and **passes** when it does not. `contents: read` is all it needs; see
[Requirements](#requirements) for the details and [optional PR comments](#github-action) for
the one feature that needs more.

To try it locally against two files, without GitHub:

```bash
git clone https://github.com/Aliloraf/contractguard.git
cd contractguard && npm ci
npm run cli -- --base examples/before.yaml --head examples/after.yaml
```

### At a glance

| | |
| --- | --- |
| **Catches** | removed operations, parameters, success responses and media types; newly required parameters, bodies and fields; request enums narrowed; response enums widened; numeric, length and item-count ranges tightened for requests or relaxed for responses; objects closed to extra properties; response fields removed or made optional; type changes, directionally, with `integer` understood as part of `number` |
| **Understands** | OpenAPI 3.0 and 3.1, YAML and JSON, internal `$ref` (including recursion), nested objects and arrays, and `allOf` wherever it can be merged without changing meaning |
| **Reports for review instead of guessing** | `anyOf`/`oneOf` changes whose effect depends on overlapping alternatives, `allOf` that cannot be merged safely, `pattern`, `format`, `multipleOf` and other constraints needing instance-level reasoning, and changed `security` requirements |
| **Does not check** | external or multi-file `$ref`, non-`2xx` responses, response headers, `servers`, `webhooks`, `callbacks`, or anything else in [the limitations](#what-the-engine-does-not-support) |

A clean report is not a proof of compatibility. Everything the engine cannot evaluate is
listed explicitly as a review-required notice rather than passed over in silence.

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

## Composed schemas (`allOf`, `anyOf`, `oneOf`)

Every finding falls into one of three outcomes, and composition is where the third one
earns its keep: a change is reported as **breaking**, left silent because it is **provably
compatible**, or raised as an **inconclusive** notice. A composed schema is never silently
assumed to be compatible.

### `allOf` is merged when the merge is provably lossless

`allOf` is an intersection of constraints, not inheritance: each branch applies to the whole
instance independently. ContractGuard merges the branches (and the enclosing schema, which
also constrains the instance) into one effective schema and then applies every ordinary rule
to it, so composed schemas get the same type, enum, constraint, property and `$ref` analysis
as flat ones. The merge intersects keyword by keyword:

| Keyword | Merged as |
| --- | --- |
| `required` | union of all branches |
| `type` | intersection of the type sets, honouring `integer` ⊂ `number` |
| `enum` | intersection of the value sets |
| `minimum`/`maximum`/`exclusive*`, `min`/`maxLength`, `min`/`maxItems`, `min`/`maxProperties` | the strictest bound from any branch |
| `properties`, `items` | per name; a name declared by several branches becomes an `allOf` of those subschemas, which is merged in turn |
| anything else (`pattern`, `format`, `oneOf`, …) | carried over when exactly one branch declares it |

Because the merge is order-insensitive, reordering branches is recognised as no change, and
nested `allOf` is collapsed first. Branch `$ref`s are resolved against their own document.

The merge is **abandoned** — raising `UNSUPPORTED_COMPOSITION` rather than a guess — when it
would alter what the schema accepts:

- **`additionalProperties` that does not govern every declared property.** This is the trap
  that makes naive flattening wrong: `allOf: [{properties: {a}}, {additionalProperties: false}]`
  rejects *every* object, because the closing branch declares no properties of its own, while
  a flattened `{properties: {a}, additionalProperties: false}` would accept `{a: 1}`. Merging
  is only allowed when every property name declared anywhere also appears in each branch that
  closes the object, which is exactly when moving the keyword changes nothing.
- Branch `type` sets or `enum` sets that do not intersect.
- Two branches declaring the same keyword differently (`pattern`, `multipleOf`, `oneOf`, …),
  since the intersection of two such constraints is not expressible as one schema.
- `additionalProperties` combined with `patternProperties` or `unevaluatedProperties`.
- A branch `$ref` that cannot be resolved, or a composition that references itself.

Branch `description`, `title`, `example` and other annotations never block a merge.

### `anyOf` and `oneOf` are compared by proof, never branch against branch

Alternatives are compared as whole lists — as multisets of fully resolved schemas, so
reordering them, or renaming a `$ref` that reaches an unchanged alternative, is recognised as
no change. Pairing alternatives up and aggregating per-branch results would invent a
correspondence the schema does not have, so it is not done.

Only these cases are provable, and only they stay silent:

| Case | Outcome |
| --- | --- |
| Alternatives unchanged (any order) | compatible |
| `anyOf` alternative **added**, request | compatible — every former alternative is still present, so nothing that was accepted is now rejected |
| `anyOf` alternative **removed**, response | compatible — the union of returned instances only shrank |

Everything else is inconclusive and raises a notice, including: an `anyOf` alternative
removed from a request (a remaining alternative may still accept the same instances), an
`anyOf` alternative added to a response (it may widen what clients receive, unless it was
already covered), **every** `oneOf` change (because "exactly one must match" means an added
alternative can invalidate instances that were valid before, whenever alternatives overlap),
and a union added or removed on one side only.

## Review-required notices

Silently skipping a construct the engine cannot evaluate would make a clean report
misleading, so those places are reported separately as notices. Notices **do not** fail the
check and **do not** change the CLI exit code; they tell you where a human still has to look.

| Notice code | Meaning |
| --- | --- |
| `UNSUPPORTED_COMPOSITION` | A composed schema could not be analysed: an `allOf` that cannot be merged without changing its meaning, or an `anyOf`/`oneOf` change whose effect depends on whether alternatives overlap. The message names the reason. |
| `UNSUPPORTED_TUPLE_ITEMS` | `prefixItems` (3.1 tuple validation) is present and is not evaluated. |
| `SCHEMA_NOT_COMPARED` | One side of a pair declares a schema and the other does not (media type, array `items`, parameter), or a parameter uses `content` serialisation. |
| `SECURITY_NOT_COMPARED` | The operation's effective `security` requirements changed; authentication compatibility is not analysed. |
| `CONSTRAINT_NOT_COMPARED` | A validation keyword that cannot be evaluated reliably changed: `pattern`, `format`, `multipleOf`, `uniqueItems`, `contains`/`minContains`/`maxContains`, `minProperties`/`maxProperties`, `patternProperties`, `propertyNames`, `dependentRequired`/`dependentSchemas`, `const`, `readOnly`/`writeOnly`, `unevaluatedProperties`/`unevaluatedItems`, or an `additionalProperties` subschema. Unchanged keywords stay quiet, since they cannot affect compatibility. |

## What the engine does **not** support

- **External or multi-file `$ref`** — any `$ref` that does not start with `#/` is rejected
  with an error (deliberate: it avoids network fetches on untrusted input).
- **`anyOf` / `oneOf` subsumption** — no overlap or containment analysis is attempted
  between alternatives, so only the provable cases above produce a verdict and every other
  change is a notice. Changes *inside* an alternative are never compared branch by branch.
- **`not` / `if` / `then` / `else` / `discriminator`** — not evaluated; a change raises
  `CONSTRAINT_NOT_COMPARED`.
- **Unmergeable `allOf`** — when a merge is abandoned, the subschema is not compared at all
  (not even its enclosing keywords), and the notice says why.
- **Schema nesting past 64 levels** is reported as not compared, as a guard against a schema
  graph that defeats the cycle checks.
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
  `workflow_dispatch`, etc., and refuses `pull_request_target` outright. Use the CLI for
  those cases.
- **Specifications generated during the build** — `spec-path` is read from the checkout as it
  stands when the step runs; nothing is generated or fetched.
- **Boolean schemas** (`items: true`, `additionalProperties: true`) are read as
  unconstrained rather than evaluated as JSON Schema booleans.

---

## Local setup

Requirements: **Node.js 24+** and npm (the published Action runs on the `node24` runtime).

```bash
git clone https://github.com/Aliloraf/contractguard.git
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

A bundled JavaScript action (`runs.using: node24`, entry point `dist/index.js`).
`dist/index.js` is **committed to the repository**, so consumers never install dependencies;
run `npm run build` and commit the result whenever `src/` or a dependency changes. CI fails
if the committed bundle is stale.

### What it compares

On a `pull_request` event ContractGuard reads the specification from the checkout and compares
it against the same path in Git history. The baseline is the common ancestor of the base
branch and **the commit that is actually checked out** — `git merge-base <base-sha> HEAD` —
which is what makes both checkout styles correct:

| Checkout | Working tree holds | Baseline | The report answers |
| --- | --- | --- | --- |
| Default (GitHub's synthetic merge commit) | base branch + this pull request, merged | the base commit, since it is already an ancestor of HEAD | "what will this API look like once this merges" |
| `ref: ${{ github.event.pull_request.head.sha }}` | only this pull request's commits | the point where the branch diverged | "what did this pull request change" |

Either way, a commit pushed to the base branch after the pull request opened is never
attributed to the pull request. The chosen baseline is logged in the step output.

If that common ancestor cannot be found — almost always a clone too shallow to contain the
shared history — the step **fails with guidance naming `fetch-depth: 0`**. ContractGuard never
falls back to a different commit, because measuring against the wrong baseline can report
changes a pull request did not make, or miss ones it did.

### Pinning a version

Pin a released tag, as the examples do:

```yaml
- uses: Aliloraf/contractguard@v0.1.0
```

Release tags are immutable, so a pinned workflow keeps behaving the same way. **No moving
`v0` tag is published**: while ContractGuard is on `0.x`, a minor release may change what is
reported, and a tag that silently moved under you could turn a passing check into a failing
one. Update the tag deliberately when you choose to; the [CHANGELOG](CHANGELOG.md) records
what changed. For maximum strictness, pin the commit SHA a tag points at.

### Requirements

- **Event:** `pull_request`. Any other event is a clear error, and `pull_request_target` is
  refused outright (see [Security](#security-notes)). Use the CLI outside pull requests.
- **Checkout:** `fetch-depth: 0`, or any depth that includes the base commit. A shallow clone
  produces an explicit error naming `fetch-depth`, never a pass.
- **Permissions:** `contents: read` is enough for the job summary. `pull-requests: write` is
  needed *only* for `comment: 'true'`.

### Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `spec-path` | yes | — | Repository-relative path to the OpenAPI 3.0/3.1 YAML or JSON document. Absolute paths, paths outside the checkout, and paths containing NUL are rejected. Paths with spaces or shell metacharacters are safe: Git is invoked with an explicit argument list and no shell. |
| `comment` | no | `false` | Post or update a sticky pull request comment with the report. Must be `true` or `false`. |
| `github-token` | no | — | Token for the optional comment. Required when `comment` is `true`; without it the comment is skipped with a warning. |

### Outputs

| Output | Description |
| --- | --- |
| `breaking` | `"true"` / `"false"` — whether any breaking change was detected. |
| `breaking-count` | Number of detected breaking changes. |
| `notice-count` | Number of places that could not be evaluated and need a manual review. Never fails the check on its own. |

### Results

| Situation | Check | Reported |
| --- | --- | --- |
| No breaking changes | **passes** | Report in the job summary |
| Breaking changes detected | **fails** | Report in the job summary, plus `breaking-count` |
| Review notices only | **passes** | Report in the job summary **and a step warning**, so a passing check never silently claims full compatibility |
| Breaking changes and notices | **fails** | Both, in the same report |
| Specification missing at the base commit, missing from the checkout, invalid, or unreadable | **fails** | An explained error. A failure is never reported as compatible |

The report is always written to the job summary; a job summary that cannot be written
degrades to a warning rather than losing the result.

### Example workflow

```yaml
name: API compatibility
on:
  pull_request:
    paths:
      - 'openapi.yaml'
permissions:
  contents: read
jobs:
  compatibility:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # required: the base commit must be readable locally
      - uses: Aliloraf/contractguard@v0.1.0
        with:
          spec-path: openapi.yaml
```

To add a sticky pull request comment, grant the extra permission and pass a token:

```yaml
permissions:
  contents: read
  pull-requests: write # only for comment: 'true'
# ...
      - uses: Aliloraf/contractguard@v0.1.0
        with:
          spec-path: openapi.yaml
          comment: 'true'
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

Repeated runs **update the same comment** rather than adding one per push. A comment is only
edited when it carries ContractGuard's report marker **and** was written by the account the
configured token acts as, resolved from the API (`GET /user`) for a personal access token, or
assumed to be `github-actions[bot]` when the API declines to name it, which is what the default
`GITHUB_TOKEN` does. The marker alone is never enough: anyone who can comment on a pull request
could paste it, and ContractGuard will not edit a comment it cannot show it owns. Such comments
are left untouched and reported as a warning, and the report is posted as a new comment.

One consequence worth knowing: if you supply an installation token for a GitHub App other than
Actions, its own account cannot be determined, so each run posts a new comment instead of
updating the previous one. Use `GITHUB_TOKEN` or a personal access token for in-place updates.

### Forks and token permissions

For a pull request from a fork, `GITHUB_TOKEN` is read-only. ContractGuard still writes the
job summary, still sets its outputs and still fails the check on a breaking change; only the
comment is skipped, with a warning that names the fork case. A comment that cannot be posted
— for any reason, including API errors — is always a warning and never changes or conceals the
compatibility result.

This repository's own `.github/workflows/integration.yml` runs the Action with
`uses: ./` on a tracked example specification, with `contents: read` and no secrets.

### Troubleshooting

| Message | Cause and fix |
| --- | --- |
| `The base commit … is not in the local clone` | Shallow checkout. Add `fetch-depth: 0` to `actions/checkout`. |
| `Could not find a common ancestor of the base commit … and the checked-out commit …` | The clone lacks the shared history (or the branches are unrelated). Add `fetch-depth: 0`. No baseline is guessed. |
| `Ignoring N comment(s) that carry the ContractGuard marker but were written by …` | Someone else's comment contains the report marker. ContractGuard left it alone and posted its own comment. Nothing to fix. |
| `Could not establish which account the token posts as` | The identity lookup failed, so no comment was edited and a new one was posted. Usually transient. |
| `… does not exist at the merge base …` | The specification is new in this pull request, so there is no baseline. Merge a baseline to the base branch first, or skip the step for that change. |
| `The specification … is missing from the checkout` | `spec-path` is wrong, or the file is generated after this step runs. |
| `ContractGuard runs on pull_request events only` | The workflow triggers on something else. Use `pull_request`, or the CLI. |
| `ContractGuard does not run on pull_request_target` | Intentional. Switch the trigger to `pull_request`. |
| `No Git repository was found in the workspace` | `actions/checkout` has not run yet in this job. |
| `The specification from … could not be read` | Not a valid OpenAPI 3.0/3.1 document, or duplicate YAML keys. The message names which side failed. |
| `comment: true needs a github-token` | Pass `github-token` and grant `pull-requests: write`. |
| `spec-path must be relative to the repository` | Use a repository-relative path, not an absolute one. |

### Manually verifying a real pull request

Automated tests cover the integration with temporary repositories and mocked APIs, but the
end-to-end behaviour on GitHub is worth confirming once per release:

1. **Compatible change.** On a branch off `main`, add an optional property to
   `examples/before.yaml` (for example `description: { type: string }` under the `/orders`
   `get` 200 response properties) and open a pull request. The *Action integration* check
   should pass, and its job summary should report no breaking changes.
2. **Breaking change.** On another branch, delete the `currency` property from the same
   response, or change `total` to `type: string`, and open a pull request. The check should
   **fail**, and the job summary should list `RESPONSE_FIELD_REMOVED` (or
   `SCHEMA_TYPE_CHANGED`) with the exact location.
3. **Comment (optional).** Add `comment: 'true'`, `github-token: ${{ secrets.GITHUB_TOKEN }}`
   and `pull-requests: write` to a workflow on a branch in this repository, then push twice.
   The first push posts one comment; the second updates it in place rather than adding a
   second one.
4. **Fork behaviour (optional).** Open the same pull request from a fork with commenting
   enabled. The check result must be identical, with a warning that the comment was skipped.

---

## Security notes

- Specifications from pull requests are treated as **data**, never code. ContractGuard
  does not execute anything from the changed repository.
- Remote/external `$ref` pointers are rejected, so no network requests are made while
  resolving a specification.
- **No shell is ever involved.** Git runs through `spawnSync` with an explicit argument list
  and `shell: false`, so nothing in a path, ref or other input can be interpreted as a
  command. A specification at `my api $(touch pwned).yaml` is read as a filename, and a
  regression test asserts that no command substitution takes place.
- `spec-path` is validated before use: it must be relative, free of NUL, and resolve inside
  the repository root as reported by Git (not merely inside the working directory).
- Commit SHAs from the event payload are matched against `^[0-9a-f]{7,64}$` before being
  passed to Git.
- **`pull_request_target` is refused.** That event hands a writable token to a workflow
  inspecting untrusted changes, and its checkout is the base branch, so the comparison would
  compare the base against itself and silently pass. ContractGuard fails with an explanation
  instead. Use `pull_request`, where the token is read-only for forks.
- **A comment is only edited when ContractGuard can show it owns it**: the report marker and
  the author must both match the account the token acts as. The marker is not a capability —
  any pull request participant can paste it — so marker-only matching would let an unrelated
  comment be overwritten on every run. Ownership that cannot be established means a new
  comment, never an edit.
- **No baseline fallback.** If the common ancestor of the base commit and HEAD cannot be
  found, the step fails with guidance rather than measuring against another commit, because a
  silently substituted baseline can turn a breaking change into a pass.
- Commenting is opt-in, needs an explicitly passed token, and every failure to comment is a
  warning — it can never conceal or alter the compatibility result.

## Roadmap

1. **v0.1** — comparison engine, CLI, bundled GitHub Action, unit tests *(done)*.
2. **v0.2** — directional type/enum rules, numeric/string/array/object constraints, safe
   `allOf` merging, provable `anyOf`/`oneOf` cases, explicit review-required notices
   *(current)*; still to come: `anyOf`/`oneOf` subsumption analysis, broader third-party
   fixtures.
3. **v0.3** — inline PR annotations, ignore/config rules, JSON diff export, multi-file `$ref`,
   multiple specification paths per run.
4. **v1.0** — full compatibility suite, published versioned Action, example repositories.

## License

MIT — see [LICENSE](LICENSE).
