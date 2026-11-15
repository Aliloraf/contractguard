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
| **Catches** | removed operations, parameters, success responses and media types; newly required parameters, bodies and fields; request enums narrowed; response enums widened; numeric, length and item-count ranges tightened for requests or relaxed for responses; objects closed to extra properties; response fields removed or made optional; type changes, directionally, with `integer` understood as part of `number`; response headers removed, made optional or changed in type, constraints or serialisation; the same body and header rules on documented error, range and `default` responses; authentication made mandatory, extra security schemes or OAuth2/OpenID Connect scopes required, and accepted authentication alternatives removed |
| **Understands** | OpenAPI 3.0 and 3.1, YAML and JSON, internal and local multi-file `$ref` (including recursion, see [Multi-file specifications](#multi-file-specifications)), nested objects and arrays, `allOf` wherever it can be merged without changing meaning, and response status keys the way OpenAPI resolves them: an explicit code, then its `nXX` range, then `default`, and `security` as an access rule: document defaults, operation overrides, `security: []`, optional authentication, alternatives (OR) and combined schemes (AND) |
| **Reports for review instead of guessing** | `anyOf`/`oneOf` changes whose effect depends on overlapping alternatives, `allOf` that cannot be merged safely, `pattern`, `format`, `multipleOf` and other constraints needing instance-level reasoning, `security` changes that hinge on a renamed, redefined or undefined scheme, and documented statuses that were added, removed or moved between an explicit code, a range and `default` |
| **Does not check** | remote (`http`/`https`) `$ref`, response `links`, media type ranges, `servers`, `webhooks`, `callbacks`, or anything else in [the limitations](#what-the-engine-does-not-support) |

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
| `SUCCESS_RESPONSE_REMOVED` | A documented `2xx` status code or `2XX` range is gone from an operation, and no remaining success response keeps what it promised. See [Responses](#responses-status-codes-and-headers). |
| `PARAMETER_REMOVED` | A path-level or operation-level parameter (`in` + `name`) is gone. |
| `PARAMETER_REQUIRED` | A parameter that was optional (or new) is now required. Path parameters count as required even when `required: true` is omitted. |
| `REQUEST_BODY_REQUIRED` | An operation's request body became `required: true`. |
| `MEDIA_TYPE_REMOVED` | A request or response media type is no longer offered. Applies to every documented response, including error, range and `default` responses, and to a header described by `content`. |
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
| `RESPONSE_FIELD_REMOVED` | A response property was removed, in a success or an error body. |
| `RESPONSE_FIELD_OPTIONAL` | A previously guaranteed (`required`) response property is now optional. The guarantee is read from `required`, whether or not the name is also declared under `properties`. |
| `RESPONSE_HEADER_REMOVED` | A documented response header is gone. Header names are matched without regard to case. |
| `RESPONSE_HEADER_OPTIONAL` | A response header that was `required: true` is now optional. |
| `RESPONSE_HEADER_SERIALIZATION_CHANGED` | `explode` changed on a header whose value is an object, so the value is written differently on the wire. |
| `SECURITY_AUTHENTICATION_REQUIRED` | An operation that accepted unauthenticated requests now requires credentials. |
| `SECURITY_SCHEME_REQUIRED` | A security requirement that used to suffice must now be combined with a further scheme. |
| `SECURITY_SCOPE_REQUIRED` | An OAuth2 or OpenID Connect requirement now demands scopes it did not demand before. |
| `SECURITY_ALTERNATIVE_REMOVED` | A previously accepted authentication alternative is gone, and no remaining alternative is satisfied by the same credentials. |

Rules apply at every depth: nested objects, array elements (reported as `path[]`), parameter
schemas, request/response bodies and response header schemas, with locations such as
`GET /orders 200 response [application/json].items[].price` and
`GET /orders 429 response header Retry-After`.

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
- **Keywords that are read together with their neighbours, split across branches.** `then`
  and `else` do nothing without the `if` beside them, `minContains`/`maxContains` nothing
  without `contains`, and `items` skips the positions covered by a `prefixItems` in the same
  schema object only. Collecting these from different branches into one schema would create
  a constraint no branch declared, so `allOf: [{if: …}, {then: …}]` is never read as
  `{if: …, then: …}`. They merge normally when one branch declares the whole group.
- `unevaluatedProperties` or `unevaluatedItems` anywhere in the composition, because they
  see only what their own schema object evaluates.
- A branch that is the boolean schema `false`, or not a schema at all. (`true` is dropped,
  since it adds nothing to an intersection.)
- A branch `$ref` that cannot be resolved, or a composition that references itself.

Branch `description`, `title`, `example` and other annotations never block a merge.

In an OpenAPI 3.1 document, keywords written beside a `$ref` constrain the instance together
with the target, so `{$ref: …, maxLength: 10}` is compared as the `allOf` of the two and
goes through the same merge. In OpenAPI 3.0 such siblings are ignored, as that version of the
specification defines.

### When two schemas count as the same

Several decisions rest on whether a schema *changed*: an `anyOf`/`oneOf` list, an `allOf`
that cannot be merged, and every keyword that is reported rather than evaluated. That is
decided on a canonical form of the schema with internal `$ref`s expanded, and the rule is
that two schemas are the same only when that is certain.

Folded together, because they accept exactly the same instances:

- object key order, and the order of `required`, `enum`, a `type` list and
  `allOf`/`anyOf`/`oneOf` branches;
- a repeated `allOf` or `anyOf` branch (not `oneOf`, where a repeated alternative can never
  be the only one that matches);
- a `$ref` and the schema it points at, so inlining or renaming a component is no change;
- `nullable: true` and a `"null"` entry in `type`; `type: [integer, number]` and `number`;
- `minLength`/`minItems`/`minProperties: 0`, `uniqueItems: false`, `nullable: false` and
  `required: []`, which say what leaving the keyword out says;
- annotations: `title`, `description`, `summary`, `default`, `example`, `examples`,
  `deprecated`, `externalDocs`, `xml`, `$comment`, `$id`, `$schema`, `$anchor`.

Annotations are dropped **only where they are keywords**. The same words are ordinary names
as keys of `properties`, `patternProperties`, `dependentSchemas` and `$defs`, and ordinary
data inside `enum`, `const` and any keyword that does not hold a subschema, where nothing is
dropped and no `$ref` is followed. A property called `title`, `description` or `default`
is compared like any other property, at any depth.

Nothing else is folded. Two spellings that happen to be equivalent for a reason the engine
does not model (`minimum: 1` on an integer against `exclusiveMinimum: 0` inside a union, a
recursive component that was renamed) count as changed and are reported for review.

### `anyOf` and `oneOf` are compared by proof, never branch against branch

Alternatives are compared as whole lists of fully resolved schemas (see
[When two schemas count as the same](#when-two-schemas-count-as-the-same)), so reordering
them, or renaming a `$ref` that reaches an unchanged alternative, is recognised as no change.
`anyOf` is compared as a set, `oneOf` as a multiset. Pairing alternatives up and aggregating per-branch results would invent a
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

## Responses, status codes and headers

Every documented response is compared, not only `2xx`: error statuses, `nXX` ranges and
`default` are held to the same directional rules as a success body. A response may only
promise *more* — so a field removed from a `404` body, a widened error `enum` or a dropped
error media type is reported with the same rule codes, at a location such as
`GET /orders 404 response [application/json].detail`.

### Response headers

Headers are compared on every response declared under the same key on both sides. Names are
matched case-insensitively, `$ref`s to `components.headers` are resolved on each side, and a
header named `Content-Type` is ignored, as OpenAPI requires.

| Change | Result |
| --- | --- |
| Header removed (required or optional) | `RESPONSE_HEADER_REMOVED` |
| `required: true` → optional | `RESPONSE_HEADER_OPTIONAL` |
| Header added; optional → required | compatible |
| Schema changed | the ordinary response-direction schema rules: `SCHEMA_TYPE_CHANGED`, `RESPONSE_ENUM_EXPANDED`, `RESPONSE_RANGE_WIDENED`, `RESPONSE_LENGTH_WIDENED`, `RESPONSE_ITEM_COUNT_WIDENED`, and the field rules for object-valued headers |
| `explode` changed, value is an object | `RESPONSE_HEADER_SERIALIZATION_CHANGED` |
| `explode` changed, value is a primitive or an array | compatible — `simple` style writes both the same way |
| `explode` changed, value type not established | `HEADER_NOT_COMPARED` |
| `style` changed; a field outside the Header Object changed (`allowEmptyValue`, …) | `HEADER_NOT_COMPARED` |
| Header described by `content` on both sides | compared through its media type schema |
| Header switched between `schema` and `content` | `HEADER_NOT_COMPARED` |
| `description`, `example(s)`, `deprecated`, `x-` extensions | ignored |

Header schemas go through the same engine as bodies, so `allOf` merging, `anyOf`/`oneOf`
notices and `CONSTRAINT_NOT_COMPARED` for `pattern` or `format` apply unchanged.

### Status codes, ranges and `default`

A response key present on both sides is compared directly. A key present on one side only is
**never judged from the key alone**: an OpenAPI document does not say which statuses an
operation really returns, so a status that appears or disappears is not proof of a behaviour
change. Instead the engine looks up the response that describes that status on the other
side, using OpenAPI's own precedence — an explicit code, then its `nXX` range, then
`default` — and compares the two definitions:

| Change | Result |
| --- | --- |
| Error status removed, and a range or `default` that describes it keeps everything it promised (`400` + `404` folded into an identical `4XX`) | compatible |
| Error status removed, and the range or `default` that now describes it promises less | `RESPONSE_COVERAGE_CHANGED` notice, naming what differs |
| Error status, range or `default` removed, with nothing left to describe it | `RESPONSE_STATUS_REMOVED` notice |
| Status newly declared, previously described by a range or `default` with a compatible definition (`404` split out of `default`) | compatible |
| Status newly declared, and its definition promises less than the range or `default` that described it before | `RESPONSE_COVERAGE_CHANGED` notice |
| Status, range or `default` newly documented where nothing described it before | `RESPONSE_STATUS_ADDED` notice |
| Success status removed, and a `2XX` range now describes it and keeps everything it promised | compatible |
| Success status removed, with no `2XX` range, or one that promises less | `SUCCESS_RESPONSE_REMOVED` |
| `2XX` range removed while explicit success codes are declared | compatible; each code is compared against the range |
| `2XX` range removed with no success response left | `SUCCESS_RESPONSE_REMOVED` |

`default` never stands in for a removed success response, and a range only describes codes
of its own class. Keys that are not a status code, an uppercase `nXX` range or `default`
(`2xx`, `20X`, `600`) are compared when present on both sides and otherwise reported as
added or removed without being interpreted; `x-` extensions are ignored.

Only `SUCCESS_RESPONSE_REMOVED` is a verdict here. Every other change to the *set* of
documented statuses is a notice, because whether a deployed client is affected depends on
what the service actually returns.
## Security requirements

`security` is compared as an **access rule**, not as an array. For each operation the engine
works out the requirements that actually apply, then asks one question: *is every set of
credentials that used to be accepted still accepted?*

**Effective requirements.** An operation's own `security` replaces the document-level
`security`; an operation without one inherits the document default. `security: []` switches
the default off, and no declaration at either level means the operation is unsecured.

**Reading a requirement.** The entries of a `security` list are alternatives — satisfying
any one is enough (OR). The schemes inside one entry must all be satisfied (AND), and for an
OAuth2 or OpenID Connect scheme every listed scope must be granted. An empty entry `{}`
admits unauthenticated requests, which is how optional authentication is written.

**The rule.** A change is compatible when each old alternative is still satisfied by at
least one new alternative: one that asks for no scheme the old alternative lacked and no
scope it lacked. Otherwise the alternative that lost its match is reported, once:

| Change | Result |
| --- | --- |
| Unsecured, or optional (`{}`), and now every alternative needs credentials | `SECURITY_AUTHENTICATION_REQUIRED` |
| `apiKey` → `apiKey` + `bearer` in the same entry | `SECURITY_SCHEME_REQUIRED` |
| `oauth: [read]` → `oauth: [read, write]` | `SECURITY_SCOPE_REQUIRED` |
| `apiKey` or `oauth` → `oauth` only, or `apiKey` swapped for a different scheme | `SECURITY_ALTERNATIVE_REMOVED` |
| Security removed, `{}` added, an alternative added, a scope or a combined scheme dropped | compatible |
| Alternatives, schemes or scopes reordered or repeated; `[]` vs `[{}]` vs no declaration; a requirement moved between the document and its operations | no change |
| An alternative removed that a weaker remaining one already covers (`oauth: [read]` kept, `oauth: [read, write]` removed) | compatible |

A change to the document-level `security` is reported on every operation that inherits it,
because each of those operations is affected; operations with their own `security` are not.

**Scheme identity is never assumed.** A verdict is only given when
`components.securitySchemes` shows what the schemes are. A scheme name means the same thing
on both sides only if its definition is unchanged for a client — `description`, an added
OAuth2 flow or an added available scope do not count as changes. Two differently named
schemes are treated as different credentials only when the documents show it. Everything
else raises `SECURITY_NOT_COMPARED` instead of a verdict:

- a requirement names a scheme that is not defined, has an unsupported `type`, or whose
  definition cannot be resolved;
- a scheme's definition changed (type, `in`/`name`, HTTP scheme, OAuth2 endpoints, a removed
  flow or scope, `openIdConnectUrl`) while operations still require it — reported once per
  scheme, at `components.securitySchemes.<name>`;
- a scheme was replaced by a new one of the same kind, which may be a rename, or by one
  that is defined exactly like it;
- the list attached to a scheme that is not OAuth2 or OpenID Connect changed (OpenAPI 3.1
  role names have no defined meaning);
- `security` is not a list of requirement objects.

An established break on one alternative and an inconclusive result on another are reported
side by side. The analysis models whether a request is *admitted*; it does not model what
an authenticated caller is entitled to, so removing an authenticated alternative while
unauthenticated access remains is treated as compatible.

## Multi-file specifications

A specification may be split across local YAML and JSON files. Both the CLI and the GitHub
Action follow relative `$ref`s, and **each side of a comparison resolves its own files**: the
baseline from the baseline revision, the new specification from the new revision. A schema
changed in `schemas/User.yaml` is reported even when `openapi.yaml` is untouched.

```yaml
# openapi.yaml
openapi: 3.1.0
info: { title: Shop, version: 1.0.0 }
paths:
  /users:
    $ref: ./paths/users.yaml                       # a whole path item
  /orders:
    get:
      parameters:
        - $ref: ./common/parameters.yaml#/components/parameters/PageSize
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: ./schemas/Order.json }
```

```yaml
# paths/users.yaml  (resolved relative to paths/, not to the root document)
get:
  responses:
    '200':
      description: ok
      content:
        application/json:
          schema: { $ref: ../schemas/User.yaml }
```

```yaml
# schemas/User.yaml
type: object
required: [id]
properties:
  id: { type: string }
  manager: { $ref: '#' }                           # recursion within the file
  address: { $ref: ./address/Address.yaml }        # schemas/address/Address.yaml
```

### How references are resolved

- A relative reference resolves against **the file that contains it**. `./address/Address.yaml`
  inside `schemas/User.yaml` means `schemas/address/Address.yaml`. A `#/...` reference inside a
  referenced file points into *that* file, not the root document.
- Every referenced file is loaded once, however often it is reached, and loaded files are
  never merged by copying: references stay references. A recursive or mutually recursive
  schema therefore stays recursive across files, and is compared with the same cycle handling
  as an internal recursion. A reference chain that never reaches a definition (`a` → `b` → `a`)
  is rejected as malformed.
- Moving a schema into another file, or splitting a document up, does not change what is
  reported: the comparison is of the resolved contract, not of file layout.
- Any failure to resolve a reference — a missing file, a pointer that does not exist, bad
  YAML/JSON, an unsupported or unsafe reference — **fails the run** (exit code `2`, or a failed
  Action step) with a message naming the reference, the file that contains it and where. It is
  never reported as compatible.

### Supported and unsupported references

| Reference | Supported |
| --- | --- |
| `#/components/schemas/X` (internal) | yes |
| `./schemas/User.yaml`, `../shared/Id.yml`, `./Order.json` (whole file) | yes |
| `./common.yaml#/components/parameters/PageSize` (file and JSON Pointer) | yes |
| JSON Pointer escapes `~0` and `~1`, percent-encoding (`%7Bid%7D`, `%20`), array indexes (`#/items/0`) | yes |
| Targets that are schemas, parameters, headers, responses, request bodies, path items, security schemes and other objects | yes |
| Nested, chained, recursive and mutually recursive references across files | yes |
| `http://` / `https://` references | **no** — never fetched |
| `file:` and any other URI scheme, `//host/...`, absolute paths (`/etc/x.yaml`, `C:/x.yaml`) | **no** |
| Anchors and named fragments (`#node`), `$id` / `$anchor` / `$dynamicRef` resolution | **no** |
| Query strings, backslashes, directories, and files that are not `.yaml`, `.yml` or `.json` | **no** |
| A reference to the whole root document (`../openapi.yaml`) | **no**; a pointer into it (`../openapi.yaml#/components/schemas/X`) is supported |
| `discriminator.mapping` values that name files | not followed (the mapping is compared as text and raises a notice when it changes) |
| `$ref` inside `example`, `examples[].value`, `default`, `enum`, `const` and `x-` extensions | not followed — it is data |

### Security restrictions

- **No network access.** Only local files are ever read.
- **Confined to a boundary.** In the Action the boundary is the repository root; a reference
  that resolves above it (`../../outside.yaml`, `%2e%2e/`, …) is rejected. In the CLI it is the
  directory of each document, widened only by an explicit `--base-root` / `--head-root`.
- **Symbolic links are never followed**, whether the link is the file or a directory on the
  way to it, whether it points outside or inside the boundary, in the working tree or committed
  in Git history. (A link in Git is a blob holding its target path; ContractGuard recognises it
  by file mode instead of parsing the path text as a document.)
- **Bounded work.** At most 500 referenced files, 10 MiB per file, 64 MiB in total, 5 million
  values walked and 128 levels of nesting per file; YAML alias expansion is capped by the
  parser. Exceeding a limit is an error, not a truncation.
- **No shell.** Paths from a specification go to Git as arguments of `spawnSync` with
  `shell: false`, and to the filesystem as paths; nothing is interpolated into a command.
- `.git` directories are not readable through a reference.

## Review-required notices

Silently skipping a construct the engine cannot evaluate would make a clean report
misleading, so those places are reported separately as notices. Notices **do not** fail the
check and **do not** change the CLI exit code; they tell you where a human still has to look.

| Notice code | Meaning |
| --- | --- |
| `UNSUPPORTED_COMPOSITION` | A composed schema could not be analysed: an `allOf` that cannot be merged without changing its meaning, or an `anyOf`/`oneOf` change whose effect depends on whether alternatives overlap. The message names the reason. |
| `UNSUPPORTED_TUPLE_ITEMS` | `prefixItems` (3.1 tuple validation) or the array form of `items` is present and is not evaluated. |
| `SCHEMA_NOT_COMPARED` | One side of a pair declares a schema and the other does not (media type, array `items`, parameter, response header), a parameter uses `content` serialisation, or a boolean schema (`true`/`false`) changed. |
| `HEADER_NOT_COMPARED` | A response header changed in a way that is not evaluated: `style`, `explode` on a value whose type is not established, a switch between `schema` and `content`, a field outside the Header Object, or a name declared twice under different capitalisation. |
| `RESPONSE_STATUS_ADDED` | A status code, range or `default` response is documented where nothing described it before. Whether the operation already returned it, and whether clients handle it, cannot be established. |
| `RESPONSE_STATUS_REMOVED` | A non-success status code, range or `default` response is gone and nothing else describes it. It may no longer be returned, or be returned undocumented. |
| `RESPONSE_COVERAGE_CHANGED` | A status is still documented, but by a different entry (an explicit code, its range, or `default`), and the new definition could not be shown to keep what the old one promised. The message lists the rule codes that differ. |
| `SECURITY_NOT_COMPARED` | A `security` change could not be decided: it depends on a scheme that is undefined, unsupported, renamed or redefined, on a role list for a scheme without scopes, or on a malformed `security` value. Also raised once per scheme, at `components.securitySchemes.<name>`, when a definition changed underneath operations that still require it. See [Security requirements](#security-requirements). |
| `CONSTRAINT_NOT_COMPARED` | A validation keyword that cannot be evaluated reliably changed: `pattern`, `format`, `multipleOf`, `uniqueItems`, `contains`/`minContains`/`maxContains`, `minProperties`/`maxProperties`, `patternProperties`, `propertyNames`, `dependentRequired`/`dependentSchemas`, `const`, `readOnly`/`writeOnly`, `unevaluatedProperties`/`unevaluatedItems`, `not`, `if`/`then`/`else`, `discriminator`, `additionalItems`, `dependencies`, or an `additionalProperties` subschema (changed, introduced on a request, dropped on a response, or newly applying to a request field that is no longer declared). A keyword counts as changed when its meaning did, including when it is spelled the same but a schema it references changed. Unchanged keywords stay quiet, since they cannot affect compatibility. |

## What the engine does **not** support

- **Remote and non-file `$ref`** — `http`, `https`, `file:` and every other URI scheme,
  absolute paths, anchors (`#name`), `$id`-based resolution and `$dynamicRef` are rejected with
  an error naming the reference. Local relative files are supported; see
  [Multi-file specifications](#multi-file-specifications) for the full list.
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
- **Security scheme definitions** — requirements are compared, definitions are not. A
  changed definition (an API key moved to another header, a different token endpoint, a
  removed OAuth2 flow) is flagged via `SECURITY_NOT_COMPARED`, never judged breaking or
  compatible. Renamed schemes are not matched up, and OpenAPI 3.1 role lists on schemes
  other than OAuth2 and OpenID Connect are not interpreted.
- **Authorization beyond the declared requirements** — what a scope or an identity is
  entitled to, scope hierarchies (a broader scope implying a narrower one) and
  vendor-specific security extensions are outside the model.
- **Which statuses an operation really returns** — added, removed and re-keyed statuses are
  compared by definition and otherwise reported as notices; apart from
  `SUCCESS_RESPONSE_REMOVED` they never fail the check.
- **Differences found while matching a status to a range or `default`** are summarised as
  rule codes in one `RESPONSE_COVERAGE_CHANGED` notice rather than listed individually.
- **Media types are matched literally** — media type ranges (`application/*`, `*/*`),
  parameters (`; charset=utf-8`) and letter case are not interpreted, for bodies or headers.
- **Response `links`** and the response `description` are not compared.
- **Header semantics beyond the schema** — what a header means (`Cache-Control` directives,
  `Link` relations, date formats) is not modelled, and header `style` values other than
  `simple` are reported rather than evaluated.
- **Constraints that need instance-level or language-level reasoning** are not evaluated:
  `pattern` (no regular expression inclusion analysis is attempted), `format`, `multipleOf`,
  `uniqueItems`, `contains`, `minProperties`/`maxProperties`, `patternProperties`,
  `propertyNames`, `dependentRequired`, `const` and `readOnly`/`writeOnly`. A change to any
  of them raises `CONSTRAINT_NOT_COMPARED` instead of being treated as compatible.
- **Annotation keywords** (`default`, `title`, `description`, `example`, `examples`,
  `deprecated`, `externalDocs`, `xml`) are ignored entirely, including for notices. That
  includes a changed request `default`, which can alter what the server does with an omitted
  field. Properties that merely share a name with an annotation are compared normally.
- **Newly declared properties** are treated as additive in both directions. A request
  property declared where undeclared properties were accepted before can still reject values
  that used to pass, and a response property added to an object that was closed or had an
  `additionalProperties` subschema is new to clients; neither is reported.
- **`additionalProperties` subschemas are not compared against each other.** Any change
  that is not provably safe raises `CONSTRAINT_NOT_COMPARED`; no verdict is reached about
  undeclared properties beyond `REQUEST_OBJECT_CLOSED` and `REQUEST_FIELD_REMOVED`.
- **`enum` values are not filtered by `type`.** A value the declared type could never accept
  still counts as an `enum` member, so adding or removing one can be reported although the
  accepted instances did not change.
- **Keywords beside a `$ref` in OpenAPI 3.0 documents** are ignored when schemas are
  compared, as the specification defines, even though some tools honour them.
- **Schema equivalence is syntactic beyond the listed foldings.** Inside `anyOf`/`oneOf`
  branches and unmergeable `allOf`, equivalent schemas written differently are reported as
  changed, and a renamed recursive component is reported as changed.
- **Schemas too large to canonicalise** (more than 20,000 nodes once references are
  expanded) are reported as changed rather than compared.
- **`servers`, `webhooks`, `callbacks`, parameter `style`/`explode`** and OpenAPI document
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
- **Boolean schemas** are not evaluated. `true` is read as the empty schema and a boolean
  schema that changed raises `SCHEMA_NOT_COMPARED`; a component that is itself a boolean and
  is reached through a `$ref` is read as unconstrained.

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
npm run cli -- --base <old-spec> --head <new-spec> [--base-root <dir>] [--head-root <dir>] [--report <file.md>]
```

Example, using the specs committed under `examples/`:

```bash
npm run cli -- --base examples/before.yaml --head examples/after.yaml --report report.md
```

Flags:

- `--base` *(required)* — path to the previous/current contract.
- `--head` *(required)* — path to the proposed contract.
- `--base-root` / `--head-root` *(optional)* — the directory tree that referenced files may
  live in, for the base and head document respectively. It defaults to the document's own
  directory, so `$ref: ../shared/User.yaml` needs a root that contains `shared/`. Nothing
  outside the root is read.
- `--report` *(optional)* — also write the Markdown report to this file.

Documents that reference other local files are followed automatically; see
[Multi-file specifications](#multi-file-specifications). Two checkouts or two directories work
as-is, each side resolving its own files:

```bash
npm run cli -- --base ../main-checkout/openapi.yaml --head openapi.yaml
# a shared directory above the specifications:
npm run cli -- --base old/api/openapi.yaml --base-root old --head new/api/openapi.yaml --head-root new
```

The report is printed to stdout. Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | No breaking changes found by the current rule set (review-required notices do not change this). |
| `1` | At least one potentially breaking change found. |
| `2` | Invalid usage, unreadable file, or an unsupported/invalid specification. |

To compare two git revisions by hand, check the base out beside the working tree so its
referenced files come with it (a single `git show` would leave them behind):

```bash
git worktree add ../base-checkout main
npm run cli -- --base ../base-checkout/openapi.yaml --head openapi.yaml
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

### Multi-file specifications in the Action

Nothing changes in the workflow: point `spec-path` at the **root** document and keep
`fetch-depth: 0`.

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
- uses: Aliloraf/contractguard@v0.1.0
  with:
    spec-path: api/openapi.yaml   # references such as ../schemas/User.yaml are followed
```

The head's referenced files are read from the checkout; the baseline's are read from the
baseline commit with `git`, never from the working tree. So a pull request that only edits
`schemas/User.yaml` is compared against `schemas/User.yaml` as it was at the baseline, and a
file that was added, moved or deleted resolves correctly on each side. References may reach
anywhere inside the repository (not only below the specification's directory) and nothing
outside it. If a referenced file is missing, unreadable, a symbolic link or malformed on either
side, the step fails and names the side.

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
- Remote `$ref` pointers are rejected, so no network requests are made while resolving a
  specification. Local file references are confined to the repository (Action) or the
  document's directory tree (CLI), never follow symbolic links, and are bounded in file
  count, size, nesting and total work; see [Security restrictions](#security-restrictions).
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
   `allOf` merging, provable `anyOf`/`oneOf` cases, directional `security` requirement
   analysis, response headers, error responses and
   status ranges, explicit review-required notices *(current)*; still to come: `anyOf`/`oneOf` subsumption analysis, broader third-party
   fixtures.
3. **v0.3** — inline PR annotations, ignore/config rules, JSON diff export,
   multiple specification paths per run.
4. **v1.0** — full compatibility suite, published versioned Action, example repositories.

## License

MIT — see [LICENSE](LICENSE).
