const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareSpecifications } = require('../.build/comparator.js');
const { renderMarkdown } = require('../.build/report.js');

const errorSchema = () => ({
  type: 'object',
  required: ['code', 'message'],
  properties: { code: { type: 'string' }, message: { type: 'string' }, detail: { type: 'string' } },
});

const jsonBody = schema => ({ description: 'r', content: { 'application/json': { schema } } });

/** One operation, `GET /orders`, with a success body and nothing else. */
const base = (version = '3.0.3') => ({
  openapi: version,
  paths: {
    '/orders': {
      get: {
        responses: {
          '200': jsonBody({ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }),
        },
      },
    },
  },
});

const responsesOf = spec => spec.paths['/orders'].get.responses;

/** Builds two documents from the base and lets the caller shape each side. */
function compare(shapeOld, shapeNew, version) {
  const before = base(version), after = base(version);
  if (shapeOld) shapeOld(responsesOf(before), before);
  if (shapeNew) shapeNew(responsesOf(after), after);
  return compareSpecifications(before, after);
}

/** Two documents whose `200` response differs only in its headers. */
function compareHeaders(oldHeaders, newHeaders, version) {
  return compare(
    r => { if (oldHeaders) r['200'].headers = oldHeaders; },
    r => { if (newHeaders) r['200'].headers = newHeaders; },
    version,
  );
}

const codesOf = findings => findings.map(f => `${f.code} @ ${f.location}`);

function assertBreaking(result, expected) {
  assert.deepEqual(codesOf(result.breaking), expected);
  assert.deepEqual(result.notices, [], 'an established verdict needs no review notice');
}

function assertCompatible(result) {
  assert.deepEqual(result.breaking, []);
  assert.deepEqual(result.notices, []);
}

function assertReviewOnly(result, expected) {
  assert.deepEqual(result.breaking, [], 'an inconclusive change is never reported as breaking');
  assert.deepEqual(codesOf(result.notices), expected);
}

const HEADER = 'GET /orders 200 response header';

// --- Response headers: presence and requiredness ------------------------------

test('removing a guaranteed response header is breaking', () => {
  const result = compareHeaders({ 'X-Request-Id': { required: true, schema: { type: 'string' } } }, {});
  assertBreaking(result, [`RESPONSE_HEADER_REMOVED @ ${HEADER} X-Request-Id`]);
  assert.match(result.breaking[0].message, /guaranteed/);
});

test('removing an optional response header is breaking, and says it was optional', () => {
  const result = compareHeaders({ 'X-Request-Id': { schema: { type: 'string' } } }, undefined);
  assertBreaking(result, [`RESPONSE_HEADER_REMOVED @ ${HEADER} X-Request-Id`]);
  assert.doesNotMatch(result.breaking[0].message, /guaranteed/);
});

test('removing the whole headers map reports every header', () => {
  const result = compareHeaders({
    'X-A': { schema: { type: 'string' } },
    'X-B': { schema: { type: 'string' } },
  }, undefined);
  assertBreaking(result, [`RESPONSE_HEADER_REMOVED @ ${HEADER} X-A`, `RESPONSE_HEADER_REMOVED @ ${HEADER} X-B`]);
});

test('a required header becoming optional is breaking', () => {
  assertBreaking(
    compareHeaders(
      { ETag: { required: true, schema: { type: 'string' } } },
      { ETag: { required: false, schema: { type: 'string' } } },
    ),
    [`RESPONSE_HEADER_OPTIONAL @ ${HEADER} ETag`],
  );
});

test('dropping `required` altogether is the same as making the header optional', () => {
  assertBreaking(
    compareHeaders(
      { ETag: { required: true, schema: { type: 'string' } } },
      { ETag: { schema: { type: 'string' } } },
    ),
    [`RESPONSE_HEADER_OPTIONAL @ ${HEADER} ETag`],
  );
});

test('an optional header becoming required is compatible', () => {
  assertCompatible(compareHeaders(
    { ETag: { schema: { type: 'string' } } },
    { ETag: { required: true, schema: { type: 'string' } } },
  ));
});

test('`required: false` written out is not a change', () => {
  assertCompatible(compareHeaders(
    { ETag: { schema: { type: 'string' } } },
    { ETag: { required: false, schema: { type: 'string' } } },
  ));
});

test('adding a response header is compatible, required or not', () => {
  assertCompatible(compareHeaders(undefined, {
    'X-New': { required: true, schema: { type: 'string' } },
    'X-Other': { schema: { type: 'integer' } },
  }));
});

test('unchanged headers report nothing', () => {
  const headers = () => ({
    'X-Rate-Limit': { required: true, schema: { type: 'integer', minimum: 0 } },
    Link: { description: 'pagination', schema: { type: 'string' } },
  });
  assertCompatible(compareHeaders(headers(), headers()));
});

test('header descriptions, examples and deprecation are not contract changes', () => {
  assertCompatible(compareHeaders(
    { ETag: { description: 'old', example: 'a', schema: { type: 'string' } } },
    { ETag: { description: 'new', example: 'b', deprecated: true, schema: { type: 'string' } } },
  ));
});

// --- Response headers: names --------------------------------------------------

test('header names are matched without regard to case', () => {
  assertCompatible(compareHeaders(
    { 'X-Request-ID': { required: true, schema: { type: 'string' } } },
    { 'x-request-id': { required: true, schema: { type: 'string' } } },
  ));
});

test('a recapitalised header is still compared', () => {
  assertBreaking(
    compareHeaders(
      { 'X-Request-ID': { required: true, schema: { type: 'string' } } },
      { 'x-request-id': { schema: { type: 'integer' } } },
    ),
    [
      `RESPONSE_HEADER_OPTIONAL @ ${HEADER} X-Request-ID`,
      `SCHEMA_TYPE_CHANGED @ ${HEADER} X-Request-ID`,
    ],
  );
});

test('a Content-Type response header is ignored, as OpenAPI requires', () => {
  assertCompatible(compareHeaders({ 'Content-Type': { required: true, schema: { type: 'string' } } }, {}));
  assertCompatible(compareHeaders(
    { 'content-type': { schema: { type: 'string' } } },
    { 'content-type': { schema: { type: 'integer' } } },
  ));
});

test('headers that differ only in case within one document are reported, not guessed', () => {
  const result = compareHeaders(
    { 'X-Trace': { schema: { type: 'string' } }, 'x-trace': { schema: { type: 'integer' } } },
    { 'X-Trace': { schema: { type: 'string' } } },
  );
  assertReviewOnly(result, [`HEADER_NOT_COMPARED @ ${HEADER} X-Trace`]);
  assert.match(result.notices[0].message, /case-insensitive/);
});

test('a case collision on the head side is reported once and hides no other header', () => {
  const result = compareHeaders(
    { 'X-Trace': { schema: { type: 'string' } }, ETag: { schema: { type: 'string' } } },
    { 'X-Trace': { schema: { type: 'string' } }, 'X-TRACE': { schema: { type: 'string' } }, 'x-trace': {} },
  );
  assert.deepEqual(codesOf(result.breaking), [`RESPONSE_HEADER_REMOVED @ ${HEADER} ETag`]);
  assert.deepEqual(codesOf(result.notices), [`HEADER_NOT_COMPARED @ ${HEADER} X-Trace`]);
});

// --- Response headers: schemas, through the schema engine ---------------------

test('a header schema type change is breaking', () => {
  const result = compareHeaders(
    { 'X-Rate-Limit': { schema: { type: 'integer' } } },
    { 'X-Rate-Limit': { schema: { type: 'string' } } },
  );
  assertBreaking(result, [`SCHEMA_TYPE_CHANGED @ ${HEADER} X-Rate-Limit`]);
  assert.match(result.breaking[0].message, /Response may now return string/);
});

test('header types are compared directionally', () => {
  assertCompatible(compareHeaders(
    { 'X-Count': { schema: { type: 'number' } } },
    { 'X-Count': { schema: { type: 'integer' } } },
  ));
  assertBreaking(
    compareHeaders(
      { 'X-Count': { schema: { type: 'integer' } } },
      { 'X-Count': { schema: { type: 'number' } } },
    ),
    [`SCHEMA_TYPE_CHANGED @ ${HEADER} X-Count`],
  );
});

test('a header becoming nullable is breaking in both dialects', () => {
  assertBreaking(
    compareHeaders(
      { 'X-Tag': { schema: { type: 'string' } } },
      { 'X-Tag': { schema: { type: 'string', nullable: true } } },
    ),
    [`SCHEMA_TYPE_CHANGED @ ${HEADER} X-Tag`],
  );
  assertBreaking(
    compareHeaders(
      { 'X-Tag': { schema: { type: 'string' } } },
      { 'X-Tag': { schema: { type: ['string', 'null'] } } },
      '3.1.0',
    ),
    [`SCHEMA_TYPE_CHANGED @ ${HEADER} X-Tag`],
  );
});

test('a header losing its type constraint is breaking', () => {
  assertBreaking(
    compareHeaders({ 'X-Tag': { schema: { type: 'string' } } }, { 'X-Tag': { schema: {} } }),
    [`SCHEMA_TYPE_CHANGED @ ${HEADER} X-Tag`],
  );
});

test('a header enum gaining a value is breaking; losing one is compatible', () => {
  const two = { 'X-Cache': { schema: { type: 'string', enum: ['HIT', 'MISS'] } } };
  const three = { 'X-Cache': { schema: { type: 'string', enum: ['HIT', 'MISS', 'STALE'] } } };
  assertBreaking(compareHeaders(two, three), [`RESPONSE_ENUM_EXPANDED @ ${HEADER} X-Cache`]);
  assertCompatible(compareHeaders(three, two));
});

test('header numeric bounds follow the response direction', () => {
  const tight = { 'X-Remaining': { schema: { type: 'integer', minimum: 0, maximum: 100 } } };
  const loose = { 'X-Remaining': { schema: { type: 'integer', minimum: 0 } } };
  assertBreaking(compareHeaders(tight, loose), [`RESPONSE_RANGE_WIDENED @ ${HEADER} X-Remaining`]);
  assertCompatible(compareHeaders(loose, tight));
});

test('header length bounds follow the response direction', () => {
  const tight = { ETag: { schema: { type: 'string', maxLength: 64 } } };
  const loose = { ETag: { schema: { type: 'string', maxLength: 128 } } };
  assertBreaking(compareHeaders(tight, loose), [`RESPONSE_LENGTH_WIDENED @ ${HEADER} ETag`]);
  assertCompatible(compareHeaders(loose, tight));
});

test('array-valued header items and item counts are compared', () => {
  const result = compareHeaders(
    { 'X-Scopes': { schema: { type: 'array', maxItems: 5, items: { type: 'string', enum: ['a', 'b'] } } } },
    { 'X-Scopes': { schema: { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] } } } },
  );
  assertBreaking(result, [
    `RESPONSE_ITEM_COUNT_WIDENED @ ${HEADER} X-Scopes`,
    `RESPONSE_ENUM_EXPANDED @ ${HEADER} X-Scopes[]`,
  ]);
});

test('object-valued header properties are compared', () => {
  const result = compareHeaders(
    { 'X-Meta': { schema: { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'string' } } } } },
    { 'X-Meta': { schema: { type: 'object', properties: { a: { type: 'string' } } } } },
  );
  assertBreaking(result, [
    `RESPONSE_FIELD_OPTIONAL @ ${HEADER} X-Meta.a`,
    `RESPONSE_FIELD_REMOVED @ ${HEADER} X-Meta.b`,
  ]);
});

test('a changed header pattern or format is a notice, not a verdict', () => {
  assertReviewOnly(
    compareHeaders(
      { ETag: { schema: { type: 'string', pattern: '^W/' } } },
      { ETag: { schema: { type: 'string', pattern: '^"' } } },
    ),
    [`CONSTRAINT_NOT_COMPARED @ ${HEADER} ETag`],
  );
  assertReviewOnly(
    compareHeaders(
      { 'Last-Modified': { schema: { type: 'string', format: 'date-time' } } },
      { 'Last-Modified': { schema: { type: 'string', format: 'date' } } },
    ),
    [`CONSTRAINT_NOT_COMPARED @ ${HEADER} Last-Modified`],
  );
});

test('a header schema composed with allOf is merged before comparison', () => {
  assertBreaking(
    compareHeaders(
      { 'X-N': { schema: { allOf: [{ type: 'integer' }, { minimum: 1 }] } } },
      { 'X-N': { schema: { allOf: [{ type: 'integer' }, { minimum: 0 }] } } },
    ),
    [`RESPONSE_RANGE_WIDENED @ ${HEADER} X-N`],
  );
});

test('a header schema union change is a composition notice', () => {
  assertReviewOnly(
    compareHeaders(
      { 'X-V': { schema: { oneOf: [{ type: 'string' }] } } },
      { 'X-V': { schema: { oneOf: [{ type: 'string' }, { type: 'integer' }] } } },
    ),
    [`UNSUPPORTED_COMPOSITION @ ${HEADER} X-V`],
  );
});

test('a header schema present on one side only is a notice', () => {
  const added = compareHeaders({ 'X-V': {} }, { 'X-V': { schema: { type: 'string' } } });
  assertReviewOnly(added, [`SCHEMA_NOT_COMPARED @ ${HEADER} X-V`]);
  assert.match(added.notices[0].message, /head side/);
  const removed = compareHeaders({ 'X-V': { schema: { type: 'string' } } }, { 'X-V': {} });
  assertReviewOnly(removed, [`SCHEMA_NOT_COMPARED @ ${HEADER} X-V`]);
  assert.match(removed.notices[0].message, /base side/);
});

// --- Response headers: references ---------------------------------------------

function withComponents(spec, components) {
  spec.components = { ...spec.components, ...components };
}

test('a header behind a $ref is resolved on each side', () => {
  const result = compare(
    (r, spec) => {
      withComponents(spec, { headers: { RateLimit: { required: true, schema: { type: 'integer' } } } });
      r['200'].headers = { 'X-Rate-Limit': { $ref: '#/components/headers/RateLimit' } };
    },
    (r, spec) => {
      withComponents(spec, { headers: { RateLimit: { schema: { type: 'string' } } } });
      r['200'].headers = { 'X-Rate-Limit': { $ref: '#/components/headers/RateLimit' } };
    },
  );
  assertBreaking(result, [
    `RESPONSE_HEADER_OPTIONAL @ ${HEADER} X-Rate-Limit`,
    `SCHEMA_TYPE_CHANGED @ ${HEADER} X-Rate-Limit`,
  ]);
});

test('inlining a referenced header, or renaming the component, is not a change', () => {
  assertCompatible(compare(
    (r, spec) => {
      withComponents(spec, { headers: { RateLimit: { required: true, schema: { type: 'integer' } } } });
      r['200'].headers = { 'X-Rate-Limit': { $ref: '#/components/headers/RateLimit' } };
    },
    r => { r['200'].headers = { 'X-Rate-Limit': { required: true, schema: { type: 'integer' } } }; },
  ));
  assertCompatible(compare(
    (r, spec) => {
      withComponents(spec, { headers: { RateLimit: { schema: { type: 'integer' } } } });
      r['200'].headers = { 'X-Rate-Limit': { $ref: '#/components/headers/RateLimit' } };
    },
    (r, spec) => {
      withComponents(spec, { headers: { Limit: { schema: { type: 'integer' } } } });
      r['200'].headers = { 'X-Rate-Limit': { $ref: '#/components/headers/Limit' } };
    },
  ));
});

test('a header reference chain and a referenced header schema are both followed', () => {
  const result = compare(
    (r, spec) => {
      withComponents(spec, {
        headers: { A: { $ref: '#/components/headers/B' }, B: { schema: { $ref: '#/components/schemas/Count' } } },
        schemas: { Count: { type: 'integer', maximum: 10 } },
      });
      r['200'].headers = { 'X-Count': { $ref: '#/components/headers/A' } };
    },
    (r, spec) => {
      withComponents(spec, {
        headers: { A: { $ref: '#/components/headers/B' }, B: { schema: { $ref: '#/components/schemas/Count' } } },
        schemas: { Count: { type: 'integer', maximum: 20 } },
      });
      r['200'].headers = { 'X-Count': { $ref: '#/components/headers/A' } };
    },
  );
  assertBreaking(result, [`RESPONSE_RANGE_WIDENED @ ${HEADER} X-Count`]);
});

test('headers of a response behind a $ref are compared', () => {
  const shape = required => (r, spec) => {
    withComponents(spec, { responses: { Ok: {
      description: 'ok', headers: { ETag: { required, schema: { type: 'string' } } },
    } } });
    r['200'] = { $ref: '#/components/responses/Ok' };
  };
  assertBreaking(compare(shape(true), shape(false)), [`RESPONSE_HEADER_OPTIONAL @ ${HEADER} ETag`]);
});

test('an unresolved or external header reference is rejected like any other', () => {
  assert.throws(
    () => compareHeaders({ 'X-A': { $ref: '#/components/headers/Missing' } }, {}),
    /Unresolved OpenAPI reference/,
  );
  assert.throws(
    () => compareHeaders({}, { 'X-A': { $ref: 'https://example.test/headers.yaml#/X' } }),
    /Only internal OpenAPI references are supported/,
  );
});

// --- Response headers: serialisation ------------------------------------------

const objectHeader = extra => ({ 'X-Meta': { schema: { type: 'object', properties: { a: { type: 'string' } } }, ...extra } });

test('changing explode on an object-valued header is breaking', () => {
  const result = compareHeaders(objectHeader({}), objectHeader({ explode: true }));
  assertBreaking(result, [`RESPONSE_HEADER_SERIALIZATION_CHANGED @ ${HEADER} X-Meta`]);
  assert.match(result.breaking[0].message, /key=value/);
  assertBreaking(
    compareHeaders(objectHeader({ explode: true }), objectHeader({ explode: false })),
    [`RESPONSE_HEADER_SERIALIZATION_CHANGED @ ${HEADER} X-Meta`],
  );
});

test('`explode: false` written out is not a change', () => {
  assertCompatible(compareHeaders(objectHeader({}), objectHeader({ explode: false })));
});

test('explode has no effect on primitive or array headers, so changing it is compatible', () => {
  assertCompatible(compareHeaders(
    { 'X-Id': { schema: { type: 'string' } } },
    { 'X-Id': { explode: true, schema: { type: 'string' } } },
  ));
  assertCompatible(compareHeaders(
    { 'X-Ids': { schema: { type: 'array', items: { type: 'string' } } } },
    { 'X-Ids': { explode: true, schema: { type: 'array', items: { type: 'string' } } } },
  ));
});

test('explode on a header whose value type is not established is a notice', () => {
  assertReviewOnly(
    compareHeaders({ 'X-Any': { schema: {} } }, { 'X-Any': { explode: true, schema: {} } }),
    [`HEADER_NOT_COMPARED @ ${HEADER} X-Any`],
  );
  assertReviewOnly(
    compareHeaders(
      { 'X-U': { schema: { type: ['object', 'string'], anyOf: [{ type: 'string' }] } } },
      { 'X-U': { explode: true, schema: { type: ['object', 'string'], anyOf: [{ type: 'string' }] } } },
      '3.1.0',
    ),
    [`HEADER_NOT_COMPARED @ ${HEADER} X-U`],
  );
});

test('explode is not blamed when the head side can no longer return an object', () => {
  assertCompatible(compareHeaders(
    { 'X-V': { schema: { type: ['object', 'string'] } } },
    { 'X-V': { explode: true, schema: { type: 'string' } } },
    '3.1.0',
  ));
});

test('explode on a header that newly allows objects reports the type change only', () => {
  assertBreaking(
    compareHeaders(
      { 'X-V': { schema: { type: 'string' } } },
      { 'X-V': { explode: true, schema: { type: ['object', 'string'] } } },
      '3.1.0',
    ),
    [`SCHEMA_TYPE_CHANGED @ ${HEADER} X-V`],
  );
});

test('a non-boolean explode is a notice', () => {
  assertReviewOnly(
    compareHeaders(objectHeader({}), objectHeader({ explode: 'yes' })),
    [`HEADER_NOT_COMPARED @ ${HEADER} X-Meta`],
  );
});

test('a header style other than simple is a notice; spelling out simple is not a change', () => {
  assertCompatible(compareHeaders(objectHeader({}), objectHeader({ style: 'simple' })));
  const result = compareHeaders(objectHeader({}), objectHeader({ style: 'form' }));
  assertReviewOnly(result, [`HEADER_NOT_COMPARED @ ${HEADER} X-Meta`]);
  assert.match(result.notices[0].message, /`style` changed/);
});

test('a changed header field outside the Header Object is a notice', () => {
  const result = compareHeaders(
    { 'X-A': { schema: { type: 'string' } } },
    { 'X-A': { allowEmptyValue: true, schema: { type: 'string' } } },
  );
  assertReviewOnly(result, [`HEADER_NOT_COMPARED @ ${HEADER} X-A`]);
  assert.match(result.notices[0].message, /allowEmptyValue/);
});

test('header specification extensions are ignored', () => {
  assertCompatible(compareHeaders(
    { 'X-A': { 'x-internal': 1, schema: { type: 'string' } } },
    { 'X-A': { 'x-internal': 2, schema: { type: 'string' } } },
  ));
});

// --- Response headers: `content` ----------------------------------------------

const contentHeader = (schema, mediaType = 'application/json') => ({ 'X-Payload': { content: { [mediaType]: { schema } } } });

test('a header described by content is compared through its media type schema', () => {
  assertBreaking(
    compareHeaders(
      contentHeader({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }),
      contentHeader({ type: 'object', properties: { a: { type: 'string' } } }),
    ),
    [`RESPONSE_FIELD_REMOVED @ ${HEADER} X-Payload [application/json].b`],
  );
});

test('a header whose content media type changed is breaking', () => {
  assertBreaking(
    compareHeaders(contentHeader({ type: 'string' }), contentHeader({ type: 'string' }, 'text/plain')),
    [`MEDIA_TYPE_REMOVED @ ${HEADER} X-Payload [application/json]`],
  );
});

test('a header switching between schema and content is a notice', () => {
  const result = compareHeaders({ 'X-Payload': { schema: { type: 'string' } } }, contentHeader({ type: 'string' }));
  assertReviewOnly(result, [`HEADER_NOT_COMPARED @ ${HEADER} X-Payload`]);
  assert.match(result.notices[0].message, /`schema` on the base side and by `content` on the head side/);
  assertReviewOnly(
    compareHeaders(contentHeader({ type: 'string' }), { 'X-Payload': {} }),
    [`HEADER_NOT_COMPARED @ ${HEADER} X-Payload`],
  );
});

// --- Headers outside 200 ------------------------------------------------------

test('headers are compared on error, range and default responses alike', () => {
  const shape = keep => r => {
    for (const key of ['429', '5XX', 'default']) {
      r[key] = { description: 'e', headers: keep ? { 'Retry-After': { required: true, schema: { type: 'integer' } } } : {} };
    }
  };
  assertBreaking(compare(shape(true), shape(false)), [
    'RESPONSE_HEADER_REMOVED @ GET /orders 429 response header Retry-After',
    'RESPONSE_HEADER_REMOVED @ GET /orders 5XX response header Retry-After',
    'RESPONSE_HEADER_REMOVED @ GET /orders default response header Retry-After',
  ]);
});

// --- Existing error responses -------------------------------------------------

function withError(key, mutate) {
  return r => {
    r[key] = jsonBody(errorSchema());
    if (mutate) mutate(r[key].content['application/json'].schema, r[key]);
  };
}

test('an unchanged error response reports nothing', () => {
  assertCompatible(compare(withError('404'), withError('404')));
});

test('removing a field from a documented 4xx error body is breaking', () => {
  assertBreaking(
    compare(withError('404'), withError('404', s => { delete s.properties.detail; })),
    ['RESPONSE_FIELD_REMOVED @ GET /orders 404 response [application/json].detail'],
  );
});

test('a guaranteed 5xx error field becoming optional is breaking', () => {
  assertBreaking(
    compare(withError('500'), withError('500', s => { s.required = ['code']; })),
    ['RESPONSE_FIELD_OPTIONAL @ GET /orders 500 response [application/json].message'],
  );
});

test('an error field type change and a widened error enum are breaking', () => {
  const result = compare(
    withError('422', s => { s.properties.code.enum = ['invalid', 'missing']; }),
    withError('422', s => {
      s.properties.code.enum = ['invalid', 'missing', 'conflict'];
      s.properties.message.type = 'integer';
    }),
  );
  assertBreaking(result, [
    'RESPONSE_ENUM_EXPANDED @ GET /orders 422 response [application/json].code',
    'SCHEMA_TYPE_CHANGED @ GET /orders 422 response [application/json].message',
  ]);
});

test('adding a field to an error body is compatible', () => {
  assertCompatible(compare(withError('400'), withError('400', s => { s.properties.traceId = { type: 'string' }; })));
});

test('removing an error media type is breaking', () => {
  assertBreaking(
    compare(
      withError('400'),
      r => { r['400'] = { description: 'e', content: { 'application/problem+json': { schema: errorSchema() } } }; },
    ),
    ['MEDIA_TYPE_REMOVED @ GET /orders 400 response [application/json]'],
  );
});

test('the default response is compared like any other', () => {
  assertBreaking(
    compare(withError('default'), withError('default', s => { delete s.properties.detail; })),
    ['RESPONSE_FIELD_REMOVED @ GET /orders default response [application/json].detail'],
  );
});

test('a status range present on both sides is compared directly', () => {
  assertBreaking(
    compare(withError('4XX'), withError('4XX', s => { s.required = []; })),
    [
      'RESPONSE_FIELD_OPTIONAL @ GET /orders 4XX response [application/json].code',
      'RESPONSE_FIELD_OPTIONAL @ GET /orders 4XX response [application/json].message',
    ],
  );
});

test('a 2XX range present on both sides is compared like a success body', () => {
  const shape = properties => r => {
    delete r['200'];
    r['2XX'] = jsonBody({ type: 'object', properties });
  };
  assertBreaking(
    compare(shape({ id: { type: 'string' }, total: { type: 'number' } }), shape({ id: { type: 'string' } })),
    ['RESPONSE_FIELD_REMOVED @ GET /orders 2XX response [application/json].total'],
  );
});

test('an error schema changed behind a shared $ref is reported on every response using it', () => {
  const shape = properties => (r, spec) => {
    withComponents(spec, { schemas: { Error: { type: 'object', properties } } });
    r['400'] = jsonBody({ $ref: '#/components/schemas/Error' });
    r['default'] = jsonBody({ $ref: '#/components/schemas/Error' });
  };
  assertBreaking(
    compare(shape({ code: { type: 'string' }, hint: { type: 'string' } }), shape({ code: { type: 'string' } })),
    [
      'RESPONSE_FIELD_REMOVED @ GET /orders 400 response [application/json].hint',
      'RESPONSE_FIELD_REMOVED @ GET /orders default response [application/json].hint',
    ],
  );
});

test('an error response whose description alone changed reports nothing', () => {
  assertCompatible(compare(
    r => { r['404'] = { description: 'Not found' }; },
    r => { r['404'] = { description: 'No such order' }; },
  ));
});

test('an error schema declared on one side only is a notice', () => {
  assertReviewOnly(
    compare(
      r => { r['404'] = { description: 'e', content: { 'application/json': {} } }; },
      withError('404'),
    ),
    ['SCHEMA_NOT_COMPARED @ GET /orders 404 response [application/json]'],
  );
});

// --- Newly documented responses -----------------------------------------------

test('a newly documented error status is a notice, never a verdict', () => {
  const result = compare(null, withError('404'));
  assertReviewOnly(result, ['RESPONSE_STATUS_ADDED @ GET /orders 404']);
  assert.match(result.notices[0].message, /client error status/);
});

test('each family of newly documented status is named in the notice', () => {
  const result = compare(null, r => {
    for (const key of ['100', '202', '301', '429', '503']) r[key] = { description: 'x' };
  });
  assertReviewOnly(result, ['100', '202', '301', '429', '503'].map(k => `RESPONSE_STATUS_ADDED @ GET /orders ${k}`));
  assert.deepEqual(
    result.notices.map(n => /Newly documented ([a-z ]+) status\./.exec(n.message)[1]),
    ['informational', 'success', 'redirection', 'client error', 'server error'],
  );
});

test('a newly documented status range or default response is a notice', () => {
  const range = compare(null, withError('5XX'));
  assertReviewOnly(range, ['RESPONSE_STATUS_ADDED @ GET /orders 5XX']);
  assert.match(range.notices[0].message, /server error statuses/);
  const fallback = compare(null, withError('default'));
  assertReviewOnly(fallback, ['RESPONSE_STATUS_ADDED @ GET /orders default']);
  assert.match(fallback.notices[0].message, /`default` response was added/);
});

test('an error status split out of default with the same definition is compatible', () => {
  assertCompatible(compare(withError('default'), r => {
    withError('default')(r);
    withError('404')(r);
    withError('409', s => { s.properties.conflictWith = { type: 'string' }; })(r);
  }));
});

test('an error status split out of default with a weaker definition is reported for review', () => {
  const result = compare(withError('default'), r => {
    withError('default')(r);
    withError('404', s => { delete s.properties.detail; })(r);
  });
  assertReviewOnly(result, ['RESPONSE_COVERAGE_CHANGED @ GET /orders 404']);
  assert.match(result.notices[0].message, /described by `default` before/);
  assert.match(result.notices[0].message, /\(RESPONSE_FIELD_REMOVED\)/);
});

test('an explicit code split out of its range takes the range, not default, as its predecessor', () => {
  const result = compare(
    r => { withError('4XX')(r); r.default = { description: 'anything' }; },
    r => {
      withError('4XX')(r); r.default = { description: 'anything' };
      withError('404', s => { s.required = ['code']; })(r);
    },
  );
  assertReviewOnly(result, ['RESPONSE_COVERAGE_CHANGED @ GET /orders 404']);
  assert.match(result.notices[0].message, /described by `4XX` before/);
  assert.match(result.notices[0].message, /RESPONSE_FIELD_OPTIONAL/);
});

test('a range added over default with the same definition is compatible', () => {
  assertCompatible(compare(withError('default'), r => { withError('default')(r); withError('4XX')(r); }));
});

test('a new success status next to an existing one is a notice', () => {
  const result = compare(null, r => { r['202'] = { description: 'Accepted' }; });
  assertReviewOnly(result, ['RESPONSE_STATUS_ADDED @ GET /orders 202']);
});

// --- Removed responses --------------------------------------------------------

test('a removed error response with nothing covering it is a notice', () => {
  const result = compare(withError('404'), null);
  assertReviewOnly(result, ['RESPONSE_STATUS_REMOVED @ GET /orders 404']);
  assert.match(result.notices[0].message, /no range or `default` response covers it/);
});

test('error statuses consolidated into a range that keeps their promises are compatible', () => {
  const result = compare(
    r => { withError('400')(r); withError('404')(r); withError('4XX')(r); },
    withError('4XX'),
  );
  assertCompatible(result);
});

test('consolidating into a newly added range reports only the widened coverage', () => {
  const result = compare(
    r => { withError('400')(r); withError('404')(r); },
    withError('4XX'),
  );
  assertReviewOnly(result, ['RESPONSE_STATUS_ADDED @ GET /orders 4XX']);
});

test('an error status folded into a default that promises less is reported for review', () => {
  const result = compare(
    r => {
      withError('default', s => { delete s.properties.detail; })(r);
      withError('404')(r);
    },
    withError('default', s => { delete s.properties.detail; }),
  );
  assertReviewOnly(result, ['RESPONSE_COVERAGE_CHANGED @ GET /orders 404']);
  assert.match(result.notices[0].message, /`default` now describes this status/);
  assert.match(result.notices[0].message, /RESPONSE_FIELD_REMOVED/);
});

test('a header lost when an error status folds into its range is part of the review', () => {
  const result = compare(
    r => {
      withError('4XX')(r);
      withError('429', (s, response) => { response.headers = { 'Retry-After': { schema: { type: 'integer' } } }; })(r);
    },
    withError('4XX'),
  );
  assertReviewOnly(result, ['RESPONSE_COVERAGE_CHANGED @ GET /orders 429']);
  assert.match(result.notices[0].message, /RESPONSE_HEADER_REMOVED/);
});

test('a removed error range narrowed to explicit codes names what remains', () => {
  const result = compare(withError('4XX'), r => { withError('400')(r); withError('404')(r); });
  assertReviewOnly(result, ['RESPONSE_STATUS_REMOVED @ GET /orders 4XX']);
  assert.match(result.notices[0].message, /Only 400, 404 remain documented/);
});

test('a removed error range covered by an equivalent default is compatible', () => {
  assertCompatible(compare(
    r => { withError('5XX')(r); withError('default')(r); },
    withError('default'),
  ));
});

test('a removed default response is a notice', () => {
  const result = compare(withError('default'), null);
  assertReviewOnly(result, ['RESPONSE_STATUS_REMOVED @ GET /orders default']);
});

test('an error status renumbered is one removal and one addition, both for review', () => {
  assertReviewOnly(
    compare(withError('404'), withError('410')),
    ['RESPONSE_STATUS_REMOVED @ GET /orders 404', 'RESPONSE_STATUS_ADDED @ GET /orders 410'],
  );
});

// --- Success statuses, ranges and default -------------------------------------

test('removing a success status with nothing in its place stays breaking', () => {
  const result = compare(null, r => { delete r['200']; });
  assertBreaking(result, ['SUCCESS_RESPONSE_REMOVED @ GET /orders 200']);
  assert.equal(result.breaking[0].message, 'Previously documented success status removed.');
});

test('a default response does not stand in for a removed success status', () => {
  const result = compare(null, r => { r.default = r['200']; delete r['200']; });
  assert.deepEqual(codesOf(result.breaking), ['SUCCESS_RESPONSE_REMOVED @ GET /orders 200']);
  assert.deepEqual(codesOf(result.notices), ['RESPONSE_STATUS_ADDED @ GET /orders default']);
});

test('a success status replaced by a 2XX range that keeps its body is not a removal', () => {
  const result = compare(null, r => { r['2XX'] = r['200']; delete r['200']; });
  assertReviewOnly(result, ['RESPONSE_STATUS_ADDED @ GET /orders 2XX']);
  assert.match(result.notices[0].message, /success statuses/);
});

test('a success status folded into an existing 2XX range that keeps its body is compatible', () => {
  assertCompatible(compare(
    r => { r['2XX'] = structuredClone(r['200']); },
    r => { r['2XX'] = r['200']; delete r['200']; },
  ));
});

test('a success status replaced by a 2XX range that drops a field is breaking', () => {
  const result = compare(null, r => {
    r['2XX'] = jsonBody({ type: 'object', properties: {} });
    delete r['200'];
  });
  assert.deepEqual(codesOf(result.breaking), ['SUCCESS_RESPONSE_REMOVED @ GET /orders 200']);
  assert.match(result.breaking[0].message, /`2XX` range that now describes it does not keep what it promised \(RESPONSE_FIELD_REMOVED\)/);
});

test('a 4XX range does not stand in for a removed success status', () => {
  const result = compare(withError('4XX'), r => { withError('4XX')(r); delete r['200']; });
  assertBreaking(result, ['SUCCESS_RESPONSE_REMOVED @ GET /orders 200']);
});

test('a 2XX range narrowed to an explicit code with the same body is compatible', () => {
  assertCompatible(compare(r => { r['2XX'] = r['200']; delete r['200']; }, null));
});

test('a 2XX range narrowed to an explicit code that promises less is reported for review', () => {
  const result = compare(
    r => { r['2XX'] = r['200']; delete r['200']; },
    r => { r['200'].content['application/json'].schema.required = []; },
  );
  assertReviewOnly(result, ['RESPONSE_COVERAGE_CHANGED @ GET /orders 200']);
  assert.match(result.notices[0].message, /described by `2XX` before/);
});

test('a removed 2XX range with no success response left is breaking', () => {
  const result = compare(
    r => { r['2XX'] = r['200']; delete r['200']; withError('default')(r); },
    r => { delete r['200']; withError('default')(r); },
  );
  assertBreaking(result, ['SUCCESS_RESPONSE_REMOVED @ GET /orders 2XX']);
  assert.equal(result.breaking[0].message, 'Previously documented success range removed.');
});

test('a success status changed to another is a removal plus a review notice', () => {
  const result = compare(null, r => { r['201'] = r['200']; delete r['200']; });
  assert.deepEqual(codesOf(result.breaking), ['SUCCESS_RESPONSE_REMOVED @ GET /orders 200']);
  assert.deepEqual(codesOf(result.notices), ['RESPONSE_STATUS_ADDED @ GET /orders 201']);
});

test('a success status split out of a default-only operation is compared with default', () => {
  const body = () => jsonBody({ type: 'object', required: ['id'], properties: { id: { type: 'string' } } });
  assertCompatible(compare(
    r => { delete r['200']; r.default = body(); },
    r => { r.default = body(); },
  ));
  assertReviewOnly(
    compare(
      r => { delete r['200']; r.default = body(); },
      r => { r['200'] = jsonBody({ type: 'object', properties: {} }); r.default = body(); },
    ),
    ['RESPONSE_COVERAGE_CHANGED @ GET /orders 200'],
  );
});

// --- Response keys ------------------------------------------------------------

test('status keys parsed from YAML as numbers behave like strings', () => {
  const before = base(), after = base();
  // A YAML mapping key written as 404 reaches the engine as the property "404".
  responsesOf(before)[404] = jsonBody(errorSchema());
  responsesOf(after)[404] = jsonBody({ type: 'object', properties: {} });
  const result = compareSpecifications(before, after);
  assert.ok(result.breaking.every(f => f.location.startsWith('GET /orders 404 response')));
  assert.ok(result.breaking.length > 0);
});

test('specification extensions among the responses are ignored', () => {
  assertCompatible(compare(r => { r['x-internal'] = { a: 1 }; }, r => { r['x-note'] = 'hello'; }));
});

test('a lowercase range is not a range, and is never interpreted as one', () => {
  const result = compare(withError('4xx'), withError('404'));
  assertReviewOnly(result, ['RESPONSE_STATUS_ADDED @ GET /orders 404', 'RESPONSE_STATUS_REMOVED @ GET /orders 4xx']);
  assert.match(result.notices[1].message, /not a status code/);
});

test('an unrecognised key present on both sides is still compared', () => {
  assertBreaking(
    compare(withError('4xx'), withError('4xx', s => { delete s.properties.detail; })),
    ['RESPONSE_FIELD_REMOVED @ GET /orders 4xx response [application/json].detail'],
  );
});

test('out-of-range and malformed status keys are reported, not classified', () => {
  const result = compare(null, r => { r['600'] = { description: 'x' }; r['20X'] = { description: 'x' }; });
  assertReviewOnly(result, ['RESPONSE_STATUS_ADDED @ GET /orders 20X', 'RESPONSE_STATUS_ADDED @ GET /orders 600']);
  for (const notice of result.notices) assert.match(notice.message, /not a status code/);
});

test('response keys that shadow Object.prototype are handled as plain keys', () => {
  const result = compare(null, r => { r.constructor = { description: 'odd' }; });
  assertReviewOnly(result, ['RESPONSE_STATUS_ADDED @ GET /orders constructor']);
  assertCompatible(compare(null, null));
});

test('an operation without responses on either side is compared without error', () => {
  assertCompatible(compare(r => { delete r['200']; }, r => { delete r['200']; }));
  const before = base(), after = base();
  delete before.paths['/orders'].get.responses;
  delete after.paths['/orders'].get.responses;
  assertCompatible(compareSpecifications(before, after));
});

test('a recursive error schema terminates', () => {
  const shape = extra => (r, spec) => {
    withComponents(spec, { schemas: { Problem: {
      type: 'object',
      required: ['title'],
      properties: { title: { type: 'string' }, causes: { type: 'array', items: { $ref: '#/components/schemas/Problem' } }, ...extra },
    } } });
    r['500'] = jsonBody({ $ref: '#/components/schemas/Problem' });
  };
  assertBreaking(
    compare(shape({ instance: { type: 'string' } }), shape({})),
    // The nested occurrence is the same pair of schemas, so it is reported once.
    ['RESPONSE_FIELD_REMOVED @ GET /orders 500 response [application/json].instance'],
  );
});

// --- Determinism and report integration ---------------------------------------

test('findings do not depend on the order responses and headers are declared in', () => {
  const build = reverse => {
    const before = base(), after = base();
    const entries = [
      ['404', jsonBody(errorSchema())],
      ['500', jsonBody(errorSchema())],
      ['default', jsonBody(errorSchema())],
    ];
    const headers = [
      ['X-A', { required: true, schema: { type: 'string' } }],
      ['X-B', { schema: { type: 'integer' } }],
    ];
    const ordered = list => Object.fromEntries(reverse ? [...list].reverse() : list);
    Object.assign(responsesOf(before), ordered(structuredClone(entries)));
    responsesOf(before)['200'].headers = ordered(structuredClone(headers));
    const changed = structuredClone(entries);
    delete changed[0][1].content['application/json'].schema.properties.detail;
    changed.splice(1, 1);
    changed.push(['503', { description: 'x' }]);
    Object.assign(responsesOf(after), ordered(changed));
    responsesOf(after)['200'].headers = { 'X-B': { schema: { type: 'string' } } };
    return compareSpecifications(before, after);
  };
  const forward = build(false);
  assert.deepEqual(build(true), forward);
  assert.deepEqual(codesOf(forward.breaking), [
    'RESPONSE_HEADER_REMOVED @ GET /orders 200 response header X-A',
    'SCHEMA_TYPE_CHANGED @ GET /orders 200 response header X-B',
    'RESPONSE_FIELD_REMOVED @ GET /orders 404 response [application/json].detail',
  ]);
  // 500 folds into an identical default; 503 leaves it for a response without a body.
  assert.deepEqual(codesOf(forward.notices), ['RESPONSE_COVERAGE_CHANGED @ GET /orders 503']);
});

test('comparing the same pair twice gives identical results', () => {
  const before = base(), after = base();
  withError('404')(responsesOf(before));
  withError('4XX', s => { delete s.properties.detail; })(responsesOf(after));
  assert.deepEqual(compareSpecifications(before, after), compareSpecifications(before, after));
});

test('comparison does not mutate either document', () => {
  const before = base(), after = base();
  withError('404')(responsesOf(before));
  responsesOf(before)['200'].headers = { ETag: { required: true, schema: { type: 'string' } } };
  withError('default')(responsesOf(after));
  const snapshots = [structuredClone(before), structuredClone(after)];
  compareSpecifications(before, after);
  assert.deepEqual([before, after], snapshots);
});

test('header and error findings appear in the Markdown report', () => {
  const result = compare(
    r => { r['200'].headers = { ETag: { required: true, schema: { type: 'string' } } }; },
    withError('503'),
  );
  const markdown = renderMarkdown(result);
  assert.match(markdown, /Found \*\*1\*\* potentially breaking changes/);
  assert.match(markdown, /`RESPONSE_HEADER_REMOVED` \| `GET \/orders 200 response header ETag`/);
  assert.match(markdown, /\*\*1\*\* place\(s\) could not be evaluated/);
  assert.match(markdown, /`RESPONSE_STATUS_ADDED` \| `GET \/orders 503`/);
});

test('a removed operation is reported once, without response findings', () => {
  const before = base(), after = base();
  withError('404')(responsesOf(before));
  delete after.paths['/orders'].get;
  assertBreaking(compareSpecifications(before, after), ['OPERATION_REMOVED @ GET /orders']);
});

// --- Real-world shapes --------------------------------------------------------

/** Petstore: a typed success with a pagination header and a catch-all error. */
const petstore = () => ({
  openapi: '3.0.0',
  info: { title: 'Swagger Petstore', version: '1.0.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100, format: 'int32' } }],
        responses: {
          '200': {
            description: 'A paged array of pets',
            headers: { 'x-next': { description: 'A link to the next page of responses', schema: { type: 'string' } } },
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pets' } } },
          },
          default: {
            description: 'unexpected error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
      post: {
        operationId: 'createPets',
        responses: {
          '201': { description: 'Null response' },
          default: {
            description: 'unexpected error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object', required: ['id', 'name'],
        properties: { id: { type: 'integer', format: 'int64' }, name: { type: 'string' }, tag: { type: 'string' } },
      },
      Pets: { type: 'array', maxItems: 100, items: { $ref: '#/components/schemas/Pet' } },
      Error: {
        type: 'object', required: ['code', 'message'],
        properties: { code: { type: 'integer', format: 'int32' }, message: { type: 'string' } },
      },
    },
  },
});

test('Petstore: an unchanged document is clean', () => {
  const result = compareSpecifications(petstore(), petstore());
  assert.equal(result.checkedOperations, 2);
  assertCompatible(result);
});

test('Petstore: dropping the x-next pagination header is breaking', () => {
  const after = petstore();
  delete after.paths['/pets'].get.responses['200'].headers;
  assertBreaking(compareSpecifications(petstore(), after), [
    'RESPONSE_HEADER_REMOVED @ GET /pets 200 response header x-next',
  ]);
});

test('Petstore: changing the shared Error schema is reported on every default response', () => {
  const after = petstore();
  after.components.schemas.Error.properties.code.type = 'string';
  assertBreaking(compareSpecifications(petstore(), after), [
    'SCHEMA_TYPE_CHANGED @ GET /pets default response [application/json].code',
    'SCHEMA_TYPE_CHANGED @ POST /pets default response [application/json].code',
  ]);
});

test('Petstore: documenting 404 with the existing Error schema is compatible', () => {
  const after = petstore();
  after.paths['/pets'].get.responses['404'] = {
    description: 'not found',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
  assertCompatible(compareSpecifications(petstore(), after));
});

/** RFC 9457 problem details shared by several statuses, plus rate limit headers. */
const problemApi = () => ({
  openapi: '3.1.0',
  info: { title: 'Billing', version: '2024-06-01' },
  paths: {
    '/invoices/{id}': {
      get: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'The invoice',
            headers: {
              ETag: { required: true, schema: { type: 'string' } },
              'X-RateLimit-Limit': { $ref: '#/components/headers/RateLimitLimit' },
              'X-RateLimit-Remaining': { $ref: '#/components/headers/RateLimitRemaining' },
              'X-RateLimit-Reset': { $ref: '#/components/headers/RateLimitReset' },
            },
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Invoice' } } },
          },
          '304': { description: 'Not modified', headers: { ETag: { required: true, schema: { type: 'string' } } } },
          '401': { $ref: '#/components/responses/Problem' },
          '404': { $ref: '#/components/responses/Problem' },
          '429': {
            description: 'Too many requests',
            headers: {
              'Retry-After': { required: true, schema: { type: 'integer', minimum: 0 } },
              'X-RateLimit-Reset': { $ref: '#/components/headers/RateLimitReset' },
            },
            content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
          },
          '5XX': { $ref: '#/components/responses/Problem' },
        },
      },
    },
  },
  components: {
    headers: {
      RateLimitLimit: { description: 'Request quota', required: true, schema: { type: 'integer', minimum: 1 } },
      RateLimitRemaining: { description: 'Requests left', required: true, schema: { type: 'integer', minimum: 0 } },
      RateLimitReset: { description: 'Epoch seconds', required: true, schema: { type: 'integer' } },
    },
    responses: {
      Problem: {
        description: 'Problem details',
        content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
      },
    },
    schemas: {
      Invoice: {
        type: 'object', required: ['id', 'status'],
        properties: { id: { type: 'string' }, status: { type: 'string', enum: ['draft', 'open', 'paid'] } },
      },
      Problem: {
        type: 'object', required: ['type', 'title', 'status'],
        properties: {
          type: { type: 'string', format: 'uri-reference' },
          title: { type: 'string' },
          status: { type: 'integer', minimum: 100, maximum: 599 },
          detail: { type: 'string' },
          instance: { type: 'string' },
          errors: { type: 'array', items: { type: 'object', required: ['pointer'], properties: { pointer: { type: 'string' }, detail: { type: 'string' } } } },
        },
      },
    },
  },
});

const invoiceGet = spec => spec.paths['/invoices/{id}'].get;
const AT = 'GET /invoices/{id}';

test('Problem API: an unchanged document is clean', () => {
  assertCompatible(compareSpecifications(problemApi(), problemApi()));
});

test('Problem API: a shared header component change reaches every response that uses it', () => {
  const after = problemApi();
  after.components.headers.RateLimitReset = { description: 'HTTP date', schema: { type: 'string' } };
  assertBreaking(compareSpecifications(problemApi(), after), [
    `RESPONSE_HEADER_OPTIONAL @ ${AT} 200 response header X-RateLimit-Reset`,
    `SCHEMA_TYPE_CHANGED @ ${AT} 200 response header X-RateLimit-Reset`,
    `RESPONSE_HEADER_OPTIONAL @ ${AT} 429 response header X-RateLimit-Reset`,
    `SCHEMA_TYPE_CHANGED @ ${AT} 429 response header X-RateLimit-Reset`,
  ]);
});

test('Problem API: dropping Retry-After from 429 is breaking', () => {
  const after = problemApi();
  delete invoiceGet(after).responses['429'].headers['Retry-After'];
  assertBreaking(compareSpecifications(problemApi(), after), [
    `RESPONSE_HEADER_REMOVED @ ${AT} 429 response header Retry-After`,
  ]);
});

test('Problem API: a problem field change is reported for every status sharing the schema', () => {
  const after = problemApi();
  after.components.schemas.Problem.required = ['type', 'title'];
  delete after.components.schemas.Problem.properties.errors.items.properties.detail;
  const result = compareSpecifications(problemApi(), after);
  assert.deepEqual(result.notices, []);
  const body = status => `${AT} ${status} response [application/problem+json]`;
  assert.deepEqual(codesOf(result.breaking), ['401', '404', '429', '5XX'].flatMap(status => [
    `RESPONSE_FIELD_REMOVED @ ${body(status)}.errors[].detail`,
    `RESPONSE_FIELD_OPTIONAL @ ${body(status)}.status`,
  ]));
});

test('Problem API: switching errors from problem+json to plain json is breaking', () => {
  const after = problemApi();
  after.components.responses.Problem.content = {
    'application/json': { schema: { $ref: '#/components/schemas/Problem' } },
  };
  assertBreaking(compareSpecifications(problemApi(), after), ['401', '404', '5XX'].map(
    status => `MEDIA_TYPE_REMOVED @ ${AT} ${status} response [application/problem+json]`,
  ));
});

test('Problem API: documenting 403 and 500 next to the existing errors', () => {
  const after = problemApi();
  invoiceGet(after).responses['403'] = { $ref: '#/components/responses/Problem' };
  invoiceGet(after).responses['500'] = { $ref: '#/components/responses/Problem' };
  // 500 was already described by 5XX with the same definition; 403 is new.
  assertReviewOnly(compareSpecifications(problemApi(), after), [`RESPONSE_STATUS_ADDED @ ${AT} 403`]);
});

test('Problem API: replacing explicit errors with one 4XX range', () => {
  const after = problemApi();
  for (const status of ['401', '404', '429']) delete invoiceGet(after).responses[status];
  invoiceGet(after).responses['4XX'] = { $ref: '#/components/responses/Problem' };
  const result = compareSpecifications(problemApi(), after);
  // 401 and 404 keep their definition under the range. 429 loses its headers,
  // and the range now also documents every other client error.
  assertReviewOnly(result, [
    `RESPONSE_COVERAGE_CHANGED @ ${AT} 429`,
    `RESPONSE_STATUS_ADDED @ ${AT} 4XX`,
  ]);
  assert.match(result.notices[0].message, /\(RESPONSE_HEADER_REMOVED\)/);
});

test('Problem API: the 304 header contract is checked although the response has no body', () => {
  const after = problemApi();
  invoiceGet(after).responses['304'].headers.ETag.required = false;
  assertBreaking(compareSpecifications(problemApi(), after), [
    `RESPONSE_HEADER_OPTIONAL @ ${AT} 304 response header ETag`,
  ]);
});

/** A file download: headers carry most of the contract. */
const downloadApi = () => ({
  openapi: '3.0.3',
  paths: {
    '/exports/{id}': {
      get: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'The export',
            headers: {
              'Content-Disposition': { required: true, schema: { type: 'string' } },
              'Content-Length': { schema: { type: 'integer', minimum: 0 } },
              'Cache-Control': { schema: { type: 'string', enum: ['no-store', 'private'] } },
              'Content-Type': { schema: { type: 'string' } },
            },
            content: { 'text/csv': { schema: { type: 'string' } } },
          },
          '202': {
            description: 'Still being prepared',
            headers: { Location: { required: true, schema: { type: 'string', format: 'uri' } } },
          },
          '302': { description: 'Moved', headers: { Location: { required: true, schema: { type: 'string', format: 'uri' } } } },
        },
      },
    },
  },
});

test('Download API: several header changes at once are each attributed precisely', () => {
  const after = downloadApi();
  const responses = after.paths['/exports/{id}'].get.responses;
  delete responses['200'].headers['Content-Disposition'];
  responses['200'].headers['Cache-Control'].schema.enum.push('public');
  responses['200'].headers['Content-Type'].schema.type = 'integer';
  responses['202'].headers.Location.schema.format = 'uri-reference';
  delete responses['302'].headers.Location.required;
  const result = compareSpecifications(downloadApi(), after);
  assert.deepEqual(codesOf(result.breaking), [
    'RESPONSE_ENUM_EXPANDED @ GET /exports/{id} 200 response header Cache-Control',
    'RESPONSE_HEADER_REMOVED @ GET /exports/{id} 200 response header Content-Disposition',
    'RESPONSE_HEADER_OPTIONAL @ GET /exports/{id} 302 response header Location',
  ]);
  assert.deepEqual(codesOf(result.notices), [
    'CONSTRAINT_NOT_COMPARED @ GET /exports/{id} 202 response header Location',
  ]);
});

// --- YAML documents, as the CLI and the Action read them ----------------------

const { loadSpecification } = require('../.build/load.js');

const yamlSpec = (responses, components = '') => loadSpecification([
  'openapi: 3.0.3',
  'info: { title: Orders, version: 1.0.0 }',
  'paths:',
  '  /orders:',
  '    get:',
  '      responses:',
  ...responses.map(line => `        ${line}`),
  components,
  '',
].join('\n'));

test('YAML: unquoted status keys and a referenced header are compared', () => {
  const components = required => [
    'components:',
    '  headers:',
    '    RequestId:',
    `      required: ${required}`,
    '      schema: { type: string }',
  ].join('\n');
  const responses = [
    '200:',
    '  description: ok',
    '  headers:',
    '    X-Request-Id: { $ref: "#/components/headers/RequestId" }',
    '404:',
    '  description: missing',
    '  content:',
    '    application/json:',
    '      schema: { type: object, required: [code], properties: { code: { type: string } } }',
  ];
  const changed = [...responses.slice(0, 8), '      schema: { type: object, properties: { code: { type: string } } }'];
  assertBreaking(
    compareSpecifications(yamlSpec(responses, components(true)), yamlSpec(changed, components(false))),
    [
      'RESPONSE_HEADER_OPTIONAL @ GET /orders 200 response header X-Request-Id',
      'RESPONSE_FIELD_OPTIONAL @ GET /orders 404 response [application/json].code',
    ],
  );
});

test('YAML: quoted and unquoted status keys are the same key', () => {
  assertCompatible(compareSpecifications(
    yamlSpec(['200: { description: ok }', '4XX: { description: bad }']),
    yamlSpec(["'200': { description: ok }", '"4XX": { description: bad }']),
  ));
});

test('YAML: a response moved behind components.responses is not a change', () => {
  const inline = yamlSpec([
    '200: { description: ok }',
    'default:',
    '  description: error',
    '  headers:',
    '    X-Trace: { schema: { type: string } }',
    '  content:',
    '    application/json:',
    '      schema: { type: object, properties: { message: { type: string } } }',
  ]);
  const referenced = yamlSpec(
    ['200: { description: ok }', 'default: { $ref: "#/components/responses/Error" }'],
    [
      'components:',
      '  responses:',
      '    Error:',
      '      description: error',
      '      headers:',
      '        X-Trace: { schema: { type: string } }',
      '      content:',
      '        application/json:',
      '          schema: { type: object, properties: { message: { type: string } } }',
    ].join('\n'),
  );
  assertCompatible(compareSpecifications(inline, referenced));
  assertCompatible(compareSpecifications(referenced, inline));
});
