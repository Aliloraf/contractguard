const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareSpecifications } = require('../.build/comparator.js');
const { renderMarkdown } = require('../.build/report.js');

const base = () => ({
  openapi: '3.0.3',
  paths: {
    '/users': {
      get: {
        parameters: [{ name: 'page', in: 'query', required: false, schema: { type: 'integer' } }],
        responses: { '200': { content: { 'application/json': { schema: {
          type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' } },
        } } } } },
      },
      post: { requestBody: { required: true, content: { 'application/json': {
        schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, age: { type: 'integer' } } },
      } } }, responses: { '201': { description: 'Created' } } },
    },
  },
});

function codes(before, after) {
  return compareSpecifications(before, after).breaking.map(f => f.code);
}

test('unchanged document passes', () => {
  const spec = base();
  const result = compareSpecifications(spec, structuredClone(spec));
  assert.equal(result.checkedOperations, 2);
  assert.deepEqual(result.breaking, []);
  assert.match(renderMarkdown(result), /No breaking changes detected/);
});

test('removing an operation is breaking', () => {
  const before = base(), after = base();
  delete after.paths['/users'].get;
  assert.ok(codes(before, after).includes('OPERATION_REMOVED'));
});

test('adding a required query parameter is breaking', () => {
  const before = base(), after = base();
  after.paths['/users'].get.parameters.push({ name: 'token', in: 'header', required: true });
  assert.ok(codes(before, after).includes('PARAMETER_REQUIRED'));
});

test('making an optional parameter required is breaking', () => {
  const before = base(), after = base();
  after.paths['/users'].get.parameters[0].required = true;
  assert.ok(codes(before, after).includes('PARAMETER_REQUIRED'));
});

test('removing optional query parameter is breaking', () => {
  const before = base(), after = base();
  after.paths['/users'].get.parameters = [];
  assert.ok(codes(before, after).includes('PARAMETER_REMOVED'));
});

test('making request field required is breaking', () => {
  const before = base(), after = base();
  after.paths['/users'].post.requestBody.content['application/json'].schema.required.push('age');
  assert.ok(codes(before, after).includes('REQUEST_FIELD_REQUIRED'));
});

test('removing response field and changing type are breaking', () => {
  const before = base(), after = base();
  const schema = after.paths['/users'].get.responses['200'].content['application/json'].schema;
  delete schema.properties.name;
  schema.properties.id.type = 'integer';
  const found = codes(before, after);
  assert.ok(found.includes('RESPONSE_FIELD_REMOVED'));
  assert.ok(found.includes('SCHEMA_TYPE_CHANGED'));
});

test('making guaranteed response property optional is breaking', () => {
  const before = base(), after = base();
  after.paths['/users'].get.responses['200'].content['application/json'].schema.required = [];
  assert.ok(codes(before, after).includes('RESPONSE_FIELD_OPTIONAL'));
});

test('additive optional request property is allowed', () => {
  const before = base(), after = base();
  after.paths['/users'].post.requestBody.content['application/json'].schema.properties.coupon = { type: 'string' };
  assert.deepEqual(codes(before, after), []);
});

test('internal $ref paths are evaluated', () => {
  const before = { openapi: '3.0.3', components: { schemas: { Person: { type: 'object', properties: { id: { type: 'string' } } } } }, paths: {
    '/users': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Person' } } } } } } },
  } };
  const after = structuredClone(before);
  delete after.components.schemas.Person.properties.id;
  assert.ok(codes(before, after).includes('RESPONSE_FIELD_REMOVED'));
});

test('remote references are rejected rather than silently ignored', () => {
  const before = base(), after = base();
  before.paths['/users'].get.responses['200'].content['application/json'].schema = { $ref: 'https://example.org/schema.json' };
  assert.throws(() => codes(before, after), /Only internal/);
});

test('narrowing numeric request enum is breaking', () => {
  const before = base(), after = base();
  before.paths['/users'].get.parameters[0].schema.enum = [10, 20];
  after.paths['/users'].get.parameters[0].schema.enum = [10];
  assert.ok(codes(before, after).includes('REQUEST_ENUM_NARROWED'));
});

// --- Response enum expansion -------------------------------------------------

function responseSchema(spec) {
  return spec.paths['/users'].get.responses['200'].content['application/json'].schema;
}

function requestSchema(spec) {
  return spec.paths['/users'].post.requestBody.content['application/json'].schema;
}

test('adding a response enum value is breaking', () => {
  const before = base(), after = base();
  responseSchema(before).properties.id.enum = ['active', 'closed'];
  responseSchema(after).properties.id.enum = ['active', 'closed', 'archived'];
  const found = codes(before, after);
  assert.ok(found.includes('RESPONSE_ENUM_EXPANDED'));
  assert.ok(!found.includes('REQUEST_ENUM_NARROWED'));
});

test('removing a response enum constraint entirely is breaking', () => {
  const before = base(), after = base();
  responseSchema(before).properties.id.enum = ['active', 'closed'];
  assert.ok(codes(before, after).includes('RESPONSE_ENUM_EXPANDED'));
});

test('narrowing a response enum is compatible', () => {
  const before = base(), after = base();
  responseSchema(before).properties.id.enum = ['active', 'closed'];
  responseSchema(after).properties.id.enum = ['active'];
  assert.deepEqual(codes(before, after), []);
});

// --- Request enum narrowing --------------------------------------------------

test('introducing a request enum where none existed is breaking', () => {
  const before = base(), after = base();
  requestSchema(after).properties.name.enum = ['alice', 'bob'];
  const found = codes(before, after);
  assert.ok(found.includes('REQUEST_ENUM_NARROWED'));
});

test('widening a request enum is compatible', () => {
  const before = base(), after = base();
  requestSchema(before).properties.name.enum = ['alice'];
  requestSchema(after).properties.name.enum = ['alice', 'bob'];
  assert.deepEqual(codes(before, after), []);
});

test('removing a request enum constraint is compatible', () => {
  const before = base(), after = base();
  requestSchema(before).properties.name.enum = ['alice'];
  assert.deepEqual(codes(before, after), []);
});

// --- Directional type comparison --------------------------------------------

test('narrowing a response type set is compatible', () => {
  const before = base(), after = base();
  responseSchema(before).properties.id.type = ['string', 'null'];
  responseSchema(after).properties.id.type = 'string';
  assert.deepEqual(codes(before, after), []);
});

test('widening a response type set is breaking', () => {
  const before = base(), after = base();
  responseSchema(after).properties.id.type = ['string', 'null'];
  const result = compareSpecifications(before, after);
  assert.ok(result.breaking.some(f => f.code === 'SCHEMA_TYPE_CHANGED' && /may now return null/.test(f.message)));
});

test('widening a request type set is compatible, narrowing is breaking', () => {
  const widened = base(), widenedAfter = base();
  requestSchema(widenedAfter).properties.age.type = ['integer', 'string'];
  assert.deepEqual(codes(widened, widenedAfter), []);

  const narrowed = base(), narrowedAfter = base();
  requestSchema(narrowed).properties.age.type = ['integer', 'string'];
  assert.ok(codes(narrowed, narrowedAfter).includes('SCHEMA_TYPE_CHANGED'));
});

test('openapi 3.0 nullable is folded into the type set', () => {
  const before = base(), after = base();
  requestSchema(before).properties.name.nullable = true;
  const found = codes(before, after);
  assert.ok(found.includes('SCHEMA_TYPE_CHANGED'), 'request no longer accepting null is breaking');

  const response = base(), responseAfter = base();
  responseSchema(responseAfter).properties.id.nullable = true;
  assert.ok(codes(response, responseAfter).includes('SCHEMA_TYPE_CHANGED'), 'response newly returning null is breaking');
});

test('constraining a previously unconstrained request value is breaking', () => {
  const before = base(), after = base();
  delete requestSchema(before).properties.name.type;
  assert.ok(codes(before, after).includes('SCHEMA_TYPE_CHANGED'));
});

test('dropping a response type constraint is breaking', () => {
  const before = base(), after = base();
  delete responseSchema(after).properties.id.type;
  assert.ok(codes(before, after).includes('SCHEMA_TYPE_CHANGED'));
});

// --- Nested objects and arrays ----------------------------------------------

test('breaking changes nested inside arrays of objects are detected', () => {
  const before = base(), after = base();
  for (const spec of [before, after]) {
    responseSchema(spec).properties.tags = {
      type: 'array',
      items: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, colour: { type: 'string' } } },
    };
  }
  delete responseSchema(after).properties.tags.items.properties.colour;
  responseSchema(after).properties.tags.items.required = [];
  const result = compareSpecifications(before, after);
  const nested = result.breaking.filter(f => f.location.includes('.tags[]'));
  assert.deepEqual(nested.map(f => f.code).sort(), ['RESPONSE_FIELD_OPTIONAL', 'RESPONSE_FIELD_REMOVED']);
  assert.ok(nested.every(f => /\.tags\[\]\.(label|colour)$/.test(f.location)), 'array element locations are reported');
});

test('an array item schema present on only one side is reported as not evaluated', () => {
  const before = base(), after = base();
  responseSchema(before).properties.id = { type: 'array', items: { type: 'string' } };
  responseSchema(after).properties.id = { type: 'array' };
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking, []);
  assert.ok(result.notices.some(f => f.code === 'SCHEMA_NOT_COMPARED' && f.location.endsWith('.id[]')));
});

// --- Required/optional and additionalProperties ------------------------------

test('closing an open request object is breaking', () => {
  const before = base(), after = base();
  requestSchema(after).additionalProperties = false;
  assert.ok(codes(before, after).includes('REQUEST_OBJECT_CLOSED'));
});

test('opening a closed request object is compatible', () => {
  const before = base(), after = base();
  requestSchema(before).additionalProperties = false;
  assert.deepEqual(codes(before, after), []);
});

test('a path parameter that spells out required: true is not a new requirement', () => {
  const before = {
    openapi: '3.0.3',
    paths: { '/users/{id}': { get: { parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } } },
  };
  const after = structuredClone(before);
  after.paths['/users/{id}'].get.parameters[0].required = true;
  assert.deepEqual(codes(before, after), []);
});

test('a parameter switching to content serialisation is reported as not evaluated', () => {
  const before = base(), after = base();
  delete after.paths['/users'].get.parameters[0].schema;
  after.paths['/users'].get.parameters[0].content = { 'application/json': { schema: { type: 'integer' } } };
  const result = compareSpecifications(before, after);
  assert.ok(result.notices.some(f => f.code === 'SCHEMA_NOT_COMPARED' && f.location.includes('query:page')));
});

// --- Unevaluated keywords and $ref ------------------------------------------

test('a composed schema is merged and compared rather than waved through', () => {
  const before = base(), after = base();
  responseSchema(before).properties.id = { allOf: [{ type: 'string' }] };
  responseSchema(after).properties.id = { allOf: [{ type: 'integer' }] };
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking.map(f => f.code), ['SCHEMA_TYPE_CHANGED']);
  assert.ok(result.breaking[0].location.endsWith('.id'));
  assert.deepEqual(result.notices, [], 'a merge that preserves meaning needs no review notice');
});

test('a composition that cannot be merged safely is flagged, not ignored', () => {
  const before = base(), after = base();
  responseSchema(before).properties.id = {
    allOf: [{ properties: { a: { type: 'string' } } }, { additionalProperties: false }],
  };
  responseSchema(after).properties.id = {
    allOf: [{ properties: { a: { type: 'integer' } } }, { additionalProperties: false }],
  };
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking, []);
  assert.ok(result.notices.some(f => f.code === 'UNSUPPORTED_COMPOSITION' && f.location.endsWith('.id')));
});

test('tuple validation is flagged instead of silently ignored', () => {
  const before = base(), after = base();
  responseSchema(before).properties.id = { type: 'array', prefixItems: [{ type: 'string' }] };
  responseSchema(after).properties.id = { type: 'array', prefixItems: [{ type: 'integer' }] };
  const result = compareSpecifications(before, after);
  assert.ok(result.notices.some(f => f.code === 'UNSUPPORTED_TUPLE_ITEMS'));
});

test('security requirement changes are flagged instead of silently ignored', () => {
  const before = base(), after = base();
  before.security = [{ apiKey: [] }];
  after.security = [{ oauth2: ['read'] }];
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking, []);
  assert.ok(result.notices.some(f => f.code === 'SECURITY_NOT_COMPARED' && f.location === 'GET /users'));
});

test('reordering identical security requirements is not flagged', () => {
  const before = base(), after = base();
  before.security = [{ apiKey: [] }, { oauth2: ['read'] }];
  after.security = [{ oauth2: ['read'] }, { apiKey: [] }];
  assert.deepEqual(compareSpecifications(before, after).notices, []);
});

test('enum rules follow $ref indirection on both sides', () => {
  const before = {
    openapi: '3.0.3',
    components: { schemas: { Status: { type: 'string', enum: ['active'] } } },
    paths: { '/users': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Status' } } } } } } } },
  };
  const after = structuredClone(before);
  after.components.schemas.Status.enum = ['active', 'archived'];
  const result = compareSpecifications(before, after);
  assert.ok(result.breaking.some(f => f.code === 'RESPONSE_ENUM_EXPANDED'));
});

test('recursive $ref schemas terminate and still report breaking changes', () => {
  const before = {
    openapi: '3.0.3',
    components: { schemas: { Node: {
      type: 'object', required: ['id'],
      properties: { id: { type: 'string' }, child: { $ref: '#/components/schemas/Node' } },
    } } },
    paths: { '/tree': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } } },
  };
  const after = structuredClone(before);
  after.components.schemas.Node.required = [];
  const result = compareSpecifications(before, after);
  assert.ok(result.breaking.some(f => f.code === 'RESPONSE_FIELD_OPTIONAL'));
});

// --- Report rendering --------------------------------------------------------

test('notices are rendered without turning a clean report into a failure', () => {
  const before = base(), after = base();
  responseSchema(before).properties.id = {
    allOf: [{ properties: { a: { type: 'string' } } }, { additionalProperties: false }],
  };
  responseSchema(after).properties.id = {
    allOf: [{ properties: { a: { type: 'integer' } } }, { additionalProperties: false }],
  };
  const result = compareSpecifications(before, after);
  const markdown = renderMarkdown(result);
  assert.match(markdown, /No breaking changes detected/);
  assert.match(markdown, /could not be evaluated/);
  assert.match(markdown, /UNSUPPORTED_COMPOSITION/);
});

test('a fully compatible change produces no breaking findings and no notices', () => {
  const before = base(), after = base();
  requestSchema(after).properties.nickname = { type: 'string' };
  responseSchema(after).properties.createdAt = { type: 'string' };
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking, []);
  assert.deepEqual(result.notices, []);
});

// --- Structural keywords never imply a type ---------------------------------
// `properties` and `items` only constrain instances that already are objects or
// arrays, so an untyped schema is unconstrained no matter which keywords it
// carries. Declaring a type is therefore a real narrowing.

test('a request gaining an explicit object type is breaking', () => {
  const before = base(), after = base();
  delete requestSchema(before).type;
  const result = compareSpecifications(before, after);
  assert.ok(result.breaking.some(f =>
    f.code === 'SCHEMA_TYPE_CHANGED' && /unconstrained and is now limited to object/.test(f.message)));
});

test('a response losing an explicit object type while keeping properties is breaking', () => {
  const before = base(), after = base();
  delete responseSchema(after).type;
  const result = compareSpecifications(before, after);
  assert.ok(result.breaking.some(f =>
    f.code === 'SCHEMA_TYPE_CHANGED' && /constraint removed/.test(f.message)));
});

test('a request losing its object type is compatible', () => {
  const before = base(), after = base();
  delete requestSchema(after).type;
  assert.deepEqual(codes(before, after), []);
});

test('a response gaining an object type is compatible', () => {
  const before = base(), after = base();
  delete responseSchema(before).type;
  assert.deepEqual(codes(before, after), []);
});

test('an untyped schema with items is unconstrained in both directions', () => {
  const requestBefore = base(), requestAfter = base();
  requestSchema(requestBefore).properties.tags = { items: { type: 'string' } };
  requestSchema(requestAfter).properties.tags = { type: 'array', items: { type: 'string' } };
  assert.ok(codes(requestBefore, requestAfter).includes('SCHEMA_TYPE_CHANGED'),
    'a request accepting any value and now only arrays is breaking');

  const responseBefore = base(), responseAfter = base();
  responseSchema(responseBefore).properties.tags = { type: 'array', items: { type: 'string' } };
  responseSchema(responseAfter).properties.tags = { items: { type: 'string' } };
  assert.ok(codes(responseBefore, responseAfter).includes('SCHEMA_TYPE_CHANGED'),
    'a response dropping its array type may now return anything');
});

test('array type changes are compatible in the opposite directions', () => {
  const request = base(), requestAfter = base();
  requestSchema(request).properties.tags = { type: 'array', items: { type: 'string' } };
  requestSchema(requestAfter).properties.tags = { items: { type: 'string' } };
  assert.deepEqual(codes(request, requestAfter), []);

  const response = base(), responseAfter = base();
  responseSchema(response).properties.tags = { items: { type: 'string' } };
  responseSchema(responseAfter).properties.tags = { type: 'array', items: { type: 'string' } };
  assert.deepEqual(codes(response, responseAfter), []);
});

test('an untyped schema is still compared through its properties and items', () => {
  const before = base(), after = base();
  delete responseSchema(before).type;
  delete responseSchema(after).type;
  delete responseSchema(after).properties.name;
  assert.ok(codes(before, after).includes('RESPONSE_FIELD_REMOVED'));
});

// --- integer is a subset of number ------------------------------------------

test('request integer -> number is compatible, number -> integer is breaking', () => {
  const widened = base(), widenedAfter = base();
  requestSchema(widenedAfter).properties.age.type = 'number';
  assert.deepEqual(codes(widened, widenedAfter), []);

  const narrowed = base(), narrowedAfter = base();
  requestSchema(narrowed).properties.age.type = 'number';
  const found = compareSpecifications(narrowed, narrowedAfter).breaking;
  assert.ok(found.some(f =>
    f.code === 'SCHEMA_TYPE_CHANGED' && /no longer accepts number/.test(f.message)));
});

test('response number -> integer is compatible, integer -> number is breaking', () => {
  const narrowed = base(), narrowedAfter = base();
  responseSchema(narrowed).properties.id.type = 'number';
  responseSchema(narrowedAfter).properties.id.type = 'integer';
  assert.deepEqual(codes(narrowed, narrowedAfter), []);

  const widened = base(), widenedAfter = base();
  responseSchema(widened).properties.id.type = 'integer';
  responseSchema(widenedAfter).properties.id.type = 'number';
  const found = compareSpecifications(widened, widenedAfter).breaking;
  assert.ok(found.some(f =>
    f.code === 'SCHEMA_TYPE_CHANGED' && /may now return number/.test(f.message)));
});

test('integer is absorbed by number inside union types', () => {
  const request = base(), requestAfter = base();
  requestSchema(request).properties.age.type = ['integer', 'string'];
  requestSchema(requestAfter).properties.age.type = ['number', 'string'];
  assert.deepEqual(codes(request, requestAfter), [], 'integer | string -> number | string accepts more');

  const collapsed = base(), collapsedAfter = base();
  requestSchema(collapsed).properties.age.type = ['integer', 'number'];
  requestSchema(collapsedAfter).properties.age.type = 'number';
  assert.deepEqual(codes(collapsed, collapsedAfter), [], 'integer | number and number accept the same values');

  const response = base(), responseAfter = base();
  responseSchema(response).properties.id.type = 'number';
  responseSchema(responseAfter).properties.id.type = ['integer', 'number'];
  assert.deepEqual(codes(response, responseAfter), [], 'number -> integer | number returns no new values');
});

test('number is not absorbed by integer inside union types', () => {
  const request = base(), requestAfter = base();
  requestSchema(request).properties.age.type = ['number', 'string'];
  requestSchema(requestAfter).properties.age.type = ['integer', 'string'];
  assert.ok(codes(request, requestAfter).includes('SCHEMA_TYPE_CHANGED'));

  const response = base(), responseAfter = base();
  responseSchema(response).properties.id.type = ['integer', 'string'];
  responseSchema(responseAfter).properties.id.type = ['number', 'string'];
  assert.ok(codes(response, responseAfter).includes('SCHEMA_TYPE_CHANGED'));
});

test('integer and number stay unrelated to other types', () => {
  const before = base(), after = base();
  responseSchema(after).properties.id.type = 'integer';
  assert.ok(codes(before, after).includes('SCHEMA_TYPE_CHANGED'), 'string -> integer is still a response break');
});

// ===========================================================================
// Schema validation constraints
// ===========================================================================

/** Applies `patch` to the named request body property of a fresh fixture. */
function withRequestProperty(name, patch) {
  const spec = base();
  Object.assign(requestSchema(spec).properties[name], patch);
  return spec;
}

/** Applies `patch` to the named response property of a fresh fixture. */
function withResponseProperty(name, patch) {
  const spec = base();
  Object.assign(responseSchema(spec).properties[name], patch);
  return spec;
}

function requestChange(name, before, after) {
  return codes(withRequestProperty(name, before), withRequestProperty(name, after));
}

function responseChange(name, before, after) {
  return codes(withResponseProperty(name, before), withResponseProperty(name, after));
}

/** The fixture's response `id` is a string, so numeric cases declare a type. */
function numericResponseChange(before, after) {
  return responseChange('id', { type: 'number', ...before }, { type: 'number', ...after });
}

// --- Numeric constraints: minimum / maximum ---------------------------------

test('raising a request minimum is breaking, lowering it is compatible', () => {
  assert.ok(requestChange('age', { minimum: 0 }, { minimum: 18 }).includes('REQUEST_RANGE_NARROWED'));
  assert.deepEqual(requestChange('age', { minimum: 18 }, { minimum: 0 }), []);
});

test('lowering a request maximum is breaking, raising it is compatible', () => {
  assert.ok(requestChange('age', { maximum: 100 }, { maximum: 60 }).includes('REQUEST_RANGE_NARROWED'));
  assert.deepEqual(requestChange('age', { maximum: 60 }, { maximum: 100 }), []);
});

test('adding a request bound is breaking, removing one is compatible', () => {
  assert.ok(requestChange('age', {}, { minimum: 18 }).includes('REQUEST_RANGE_NARROWED'));
  assert.ok(requestChange('age', {}, { maximum: 60 }).includes('REQUEST_RANGE_NARROWED'));
  assert.deepEqual(requestChange('age', { minimum: 18, maximum: 60 }, {}), []);
});

test('relaxing a response bound is breaking, tightening it is compatible', () => {
  assert.ok(numericResponseChange({ minimum: 0 }, { minimum: -10 }).includes('RESPONSE_RANGE_WIDENED'));
  assert.ok(numericResponseChange({ maximum: 100 }, { maximum: 1000 }).includes('RESPONSE_RANGE_WIDENED'));
  assert.deepEqual(numericResponseChange({ minimum: 0, maximum: 100 }, { minimum: 10, maximum: 90 }), []);
});

test('removing a response bound is breaking, adding one is compatible', () => {
  assert.ok(numericResponseChange({ minimum: 0 }, {}).includes('RESPONSE_RANGE_WIDENED'));
  assert.ok(numericResponseChange({ maximum: 100 }, {}).includes('RESPONSE_RANGE_WIDENED'));
  assert.deepEqual(numericResponseChange({}, { minimum: 0, maximum: 100 }), []);
});

test('an unchanged bound reports nothing in either direction', () => {
  assert.deepEqual(requestChange('age', { minimum: 1, maximum: 9 }, { minimum: 1, maximum: 9 }), []);
  assert.deepEqual(numericResponseChange({ minimum: 1, maximum: 9 }, { minimum: 1, maximum: 9 }), []);
});

test('tightening both numeric bounds at once reports both edges', () => {
  const found = compareSpecifications(
    withRequestProperty('age', { minimum: 0, maximum: 100 }),
    withRequestProperty('age', { minimum: 10, maximum: 90 }),
  ).breaking.filter(f => f.code === 'REQUEST_RANGE_NARROWED');
  assert.equal(found.length, 2);
  assert.ok(found.some(f => /Minimum tightened/.test(f.message)));
  assert.ok(found.some(f => /Maximum tightened/.test(f.message)));
});

// --- Exclusive bounds: 3.0 boolean form vs 3.1 numeric form -----------------

test('an inclusive bound becoming exclusive is breaking for requests', () => {
  assert.ok(requestChange('age', { minimum: 5 }, { minimum: 5, exclusiveMinimum: true })
    .includes('REQUEST_RANGE_NARROWED'));
  assert.ok(requestChange('age', { maximum: 5 }, { maximum: 5, exclusiveMaximum: true })
    .includes('REQUEST_RANGE_NARROWED'));
});

test('an exclusive bound becoming inclusive is breaking for responses', () => {
  assert.ok(numericResponseChange({ minimum: 5, exclusiveMinimum: true }, { minimum: 5 })
    .includes('RESPONSE_RANGE_WIDENED'));
  assert.ok(numericResponseChange({ maximum: 5, exclusiveMaximum: true }, { maximum: 5 })
    .includes('RESPONSE_RANGE_WIDENED'));
});

test('an exclusive bound becoming inclusive is compatible for requests', () => {
  assert.deepEqual(requestChange('age', { minimum: 5, exclusiveMinimum: true }, { minimum: 5 }), []);
  assert.deepEqual(requestChange('age', { maximum: 5, exclusiveMaximum: true }, { maximum: 5 }), []);
});

test('the 3.0 boolean form and the 3.1 numeric form are equivalent', () => {
  assert.deepEqual(requestChange('age', { minimum: 5, exclusiveMinimum: true }, { exclusiveMinimum: 5 }), []);
  assert.deepEqual(numericResponseChange({ minimum: 5, exclusiveMinimum: true }, { exclusiveMinimum: 5 }), []);
  assert.deepEqual(requestChange('age', { maximum: 5, exclusiveMaximum: true }, { exclusiveMaximum: 5 }), []);
  assert.deepEqual(numericResponseChange({ maximum: 5, exclusiveMaximum: true }, { exclusiveMaximum: 5 }), []);
});

test('an explicit exclusiveMinimum: false is the same as omitting it', () => {
  assert.deepEqual(requestChange('age', { minimum: 5 }, { minimum: 5, exclusiveMinimum: false }), []);
  assert.deepEqual(numericResponseChange({ maximum: 5 }, { maximum: 5, exclusiveMaximum: false }), []);
});

test('the stricter bound wins when minimum and numeric exclusiveMinimum disagree', () => {
  assert.deepEqual(requestChange('age', { exclusiveMinimum: 5 }, { minimum: 1, exclusiveMinimum: 5 }), []);
  assert.ok(requestChange('age', { minimum: 1 }, { minimum: 1, exclusiveMinimum: 5 })
    .includes('REQUEST_RANGE_NARROWED'));
});

test('the 3.1 numeric exclusive form compares as a real bound', () => {
  assert.ok(requestChange('age', { exclusiveMinimum: 1 }, { exclusiveMinimum: 5 })
    .includes('REQUEST_RANGE_NARROWED'));
  assert.deepEqual(requestChange('age', { exclusiveMinimum: 5 }, { exclusiveMinimum: 1 }), []);
  assert.ok(numericResponseChange({ exclusiveMaximum: 5 }, { exclusiveMaximum: 50 })
    .includes('RESPONSE_RANGE_WIDENED'));
});

test('exclusive and inclusive integer bounds that accept the same values are equivalent', () => {
  assert.deepEqual(requestChange('age', { type: 'integer', minimum: 5 }, { type: 'integer', exclusiveMinimum: 4 }), []);
  assert.deepEqual(responseChange('id', { type: 'integer', exclusiveMinimum: 4 }, { type: 'integer', minimum: 5 }), []);
  assert.deepEqual(requestChange('age', { exclusiveMaximum: 6 }, { maximum: 5 }), [], 'integer fixture property');
  assert.deepEqual(requestChange('age', { type: 'integer', maximum: 5 }, { type: 'integer', exclusiveMaximum: 6 }), []);
});

test('bounds are not snapped for number-typed schemas', () => {
  assert.ok(responseChange('id', { type: 'number', minimum: 5 }, { type: 'number', exclusiveMinimum: 4 })
    .includes('RESPONSE_RANGE_WIDENED'));
  assert.deepEqual(requestChange('age', { type: 'number', minimum: 5 }, { type: 'number', exclusiveMinimum: 4 }), []);
});

// --- String constraints: minLength / maxLength -------------------------------

test('raising a request minLength is breaking, lowering it is compatible', () => {
  assert.ok(requestChange('name', { minLength: 1 }, { minLength: 8 }).includes('REQUEST_LENGTH_NARROWED'));
  assert.deepEqual(requestChange('name', { minLength: 8 }, { minLength: 1 }), []);
});

test('lowering a request maxLength is breaking, raising it is compatible', () => {
  assert.ok(requestChange('name', { maxLength: 100 }, { maxLength: 20 }).includes('REQUEST_LENGTH_NARROWED'));
  assert.deepEqual(requestChange('name', { maxLength: 20 }, { maxLength: 100 }), []);
});

test('adding a request length constraint is breaking, removing one is compatible', () => {
  assert.ok(requestChange('name', {}, { maxLength: 20 }).includes('REQUEST_LENGTH_NARROWED'));
  assert.deepEqual(requestChange('name', { minLength: 2, maxLength: 20 }, {}), []);
});

test('relaxing a response length guarantee is breaking', () => {
  assert.ok(responseChange('name', { maxLength: 20 }, { maxLength: 200 }).includes('RESPONSE_LENGTH_WIDENED'));
  assert.ok(responseChange('name', { maxLength: 20 }, {}).includes('RESPONSE_LENGTH_WIDENED'));
  assert.ok(responseChange('name', { minLength: 5 }, { minLength: 1 }).includes('RESPONSE_LENGTH_WIDENED'));
});

test('tightening a response length guarantee is compatible', () => {
  assert.deepEqual(responseChange('name', { minLength: 1, maxLength: 200 }, { minLength: 5, maxLength: 20 }), []);
  assert.deepEqual(responseChange('name', {}, { minLength: 5, maxLength: 20 }), []);
});

test('an absent minimum length is the same as zero', () => {
  assert.deepEqual(requestChange('name', {}, { minLength: 0 }), []);
  assert.deepEqual(requestChange('name', { minLength: 0 }, {}), []);
  assert.deepEqual(responseChange('name', {}, { minLength: 0 }), []);
  assert.deepEqual(responseChange('name', { minLength: 0 }, {}), []);
});

test('length constraints are ignored on schemas that cannot be strings', () => {
  assert.deepEqual(requestChange('age', { maxLength: 5 }, { maxLength: 2 }), []);
  assert.deepEqual(responseChange('id', { type: 'number', maxLength: 5 }, { type: 'number' }), []);
});

test('numeric constraints are ignored on schemas that cannot be numbers', () => {
  assert.deepEqual(requestChange('name', { minimum: 1 }, { minimum: 5 }), []);
  assert.deepEqual(responseChange('id', { minimum: 0 }, {}), []);
});

test('constraints are compared when neither side declares a type', () => {
  const before = base(), after = base();
  requestSchema(before).properties.value = { maxLength: 50 };
  requestSchema(after).properties.value = { maxLength: 10 };
  assert.ok(codes(before, after).includes('REQUEST_LENGTH_NARROWED'));
});

// --- Array constraints: minItems / maxItems ---------------------------------

const arrayProperty = (extra) => ({ type: 'array', items: { type: 'string' }, ...extra });

test('tightening request item counts is breaking, relaxing them is compatible', () => {
  assert.ok(requestChange('name', arrayProperty({ minItems: 0 }), arrayProperty({ minItems: 2 }))
    .includes('REQUEST_ITEM_COUNT_NARROWED'));
  assert.ok(requestChange('name', arrayProperty({ maxItems: 10 }), arrayProperty({ maxItems: 5 }))
    .includes('REQUEST_ITEM_COUNT_NARROWED'));
  assert.deepEqual(requestChange('name', arrayProperty({ minItems: 2, maxItems: 5 }), arrayProperty({})), []);
});

test('relaxing response item counts is breaking, tightening them is compatible', () => {
  assert.ok(responseChange('name', arrayProperty({ maxItems: 5 }), arrayProperty({ maxItems: 50 }))
    .includes('RESPONSE_ITEM_COUNT_WIDENED'));
  assert.ok(responseChange('name', arrayProperty({ minItems: 1 }), arrayProperty({}))
    .includes('RESPONSE_ITEM_COUNT_WIDENED'));
  assert.deepEqual(responseChange('name', arrayProperty({}), arrayProperty({ minItems: 1, maxItems: 5 })), []);
});

test('an absent minimum item count is the same as zero', () => {
  assert.deepEqual(requestChange('name', arrayProperty({}), arrayProperty({ minItems: 0 })), []);
  assert.deepEqual(responseChange('name', arrayProperty({ minItems: 0 }), arrayProperty({})), []);
});

test('item count constraints are ignored on schemas that cannot be arrays', () => {
  assert.deepEqual(requestChange('age', { minItems: 1 }, { minItems: 5 }), []);
});

// --- Nesting, arrays of objects and $ref ------------------------------------

test('constraints are compared inside nested objects and array elements', () => {
  const before = base(), after = base();
  for (const spec of [before, after]) {
    responseSchema(spec).properties.lines = {
      type: 'array',
      items: { type: 'object', properties: { price: { type: 'number', maximum: 100 } } },
    };
  }
  responseSchema(after).properties.lines.items.properties.price.maximum = 1000;
  const found = compareSpecifications(before, after).breaking;
  assert.ok(found.some(f =>
    f.code === 'RESPONSE_RANGE_WIDENED' && f.location.endsWith('.lines[].price')));
});

test('constraints are compared through internal $ref indirection', () => {
  const before = {
    openapi: '3.1.0',
    components: { schemas: { Price: { type: 'number', minimum: 0, maximum: 100 } } },
    paths: { '/items': {
      get: { responses: { '200': { content: { 'application/json': { schema: {
        type: 'object', properties: { price: { $ref: '#/components/schemas/Price' } },
      } } } } } },
      post: { requestBody: { content: { 'application/json': { schema: {
        type: 'object', properties: { price: { $ref: '#/components/schemas/Price' } },
      } } } }, responses: { '201': { description: 'Created' } } },
    } },
  };
  const after = structuredClone(before);
  after.components.schemas.Price.minimum = 10;
  const found = compareSpecifications(before, after).breaking;
  assert.ok(found.some(f => f.code === 'RESPONSE_RANGE_WIDENED' || f.code === 'REQUEST_RANGE_NARROWED'),
    'a shared referenced schema is compared in both directions');
  assert.ok(found.some(f => f.code === 'REQUEST_RANGE_NARROWED' && f.location.includes('POST /items request')));
});

test('constraints are compared on parameter schemas', () => {
  const before = base(), after = base();
  before.paths['/users'].get.parameters[0].schema = { type: 'integer', minimum: 1, maximum: 100 };
  after.paths['/users'].get.parameters[0].schema = { type: 'integer', minimum: 1, maximum: 50 };
  const found = compareSpecifications(before, after).breaking;
  assert.ok(found.some(f => f.code === 'REQUEST_RANGE_NARROWED' && f.location.includes('query:page')));
});

test('constraints combine with enum and type findings at the same location', () => {
  const before = base(), after = base();
  requestSchema(before).properties.age = { type: 'integer', minimum: 0 };
  requestSchema(after).properties.age = { type: 'integer', minimum: 5, enum: [5, 6] };
  const found = codes(before, after).sort();
  assert.deepEqual(found, ['REQUEST_ENUM_NARROWED', 'REQUEST_RANGE_NARROWED']);
});

// --- Object constraints: the untyped additionalProperties gap ---------------

test('closing an untyped schema is breaking for requests', () => {
  const before = base(), after = base();
  requestSchema(before).properties.profile = {};
  requestSchema(after).properties.profile = { additionalProperties: false };
  const found = compareSpecifications(before, after).breaking;
  assert.ok(found.some(f => f.code === 'REQUEST_OBJECT_CLOSED' && f.location.endsWith('.profile')));
});

test('closing an untyped schema does not claim the instance is an object', () => {
  const before = base(), after = base();
  requestSchema(before).properties.profile = {};
  requestSchema(after).properties.profile = { additionalProperties: false };
  assert.ok(!codes(before, after).includes('SCHEMA_TYPE_CHANGED'));
});

test('closing an object is not reported for responses', () => {
  const before = base(), after = base();
  responseSchema(before).properties.profile = {};
  responseSchema(after).properties.profile = { additionalProperties: false };
  assert.deepEqual(codes(before, after), []);
});

test('additionalProperties is ignored on schemas that cannot be objects', () => {
  const before = base(), after = base();
  requestSchema(before).properties.name = { type: 'string' };
  requestSchema(after).properties.name = { type: 'string', additionalProperties: false };
  assert.deepEqual(codes(before, after), []);
});

test('closing a schema that only declares properties is still breaking', () => {
  const before = base(), after = base();
  requestSchema(before).properties.profile = { properties: { city: { type: 'string' } } };
  requestSchema(after).properties.profile = { properties: { city: { type: 'string' } }, additionalProperties: false };
  assert.ok(codes(before, after).includes('REQUEST_OBJECT_CLOSED'));
});

// --- Constraints that cannot be evaluated reliably --------------------------

test('a changed pattern is reported as a review-required notice', () => {
  const before = base(), after = base();
  requestSchema(before).properties.name.pattern = '^[a-z]+$';
  requestSchema(after).properties.name.pattern = '^[a-z]{3,}$';
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking, []);
  assert.ok(result.notices.some(f =>
    f.code === 'CONSTRAINT_NOT_COMPARED' && /`pattern` changed/.test(f.message)));
});

test('an unchanged pattern produces no notice', () => {
  const before = base(), after = base();
  requestSchema(before).properties.name.pattern = '^[a-z]+$';
  requestSchema(after).properties.name.pattern = '^[a-z]+$';
  assert.deepEqual(compareSpecifications(before, after).notices, []);
});

test('an added or removed pattern is reported', () => {
  const added = base(), addedAfter = base();
  addedAfter.paths['/users'].post.requestBody.content['application/json'].schema.properties.name.pattern = '^x$';
  assert.ok(compareSpecifications(added, addedAfter).notices.some(f =>
    f.code === 'CONSTRAINT_NOT_COMPARED' && /absent → /.test(f.message)));

  const removed = base(), removedAfter = base();
  removed.paths['/users'].post.requestBody.content['application/json'].schema.properties.name.pattern = '^x$';
  assert.ok(compareSpecifications(removed, removedAfter).notices.some(f =>
    f.code === 'CONSTRAINT_NOT_COMPARED' && / → absent/.test(f.message)));
});

test('other unevaluated validation keywords are reported when they change', () => {
  const keywords = {
    format: ['date-time', 'date'],
    multipleOf: [1, 5],
    uniqueItems: [false, true],
    minProperties: [1, 3],
    maxProperties: [10, 2],
    readOnly: [false, true],
    const: ['a', 'b'],
  };
  for (const [keyword, [before, after]] of Object.entries(keywords)) {
    const result = compareSpecifications(
      withRequestProperty('name', { [keyword]: before }),
      withRequestProperty('name', { [keyword]: after }),
    );
    assert.ok(
      result.notices.some(f => f.code === 'CONSTRAINT_NOT_COMPARED' && f.message.includes(`\`${keyword}\` changed`)),
      `${keyword} should raise a notice`,
    );
    assert.deepEqual(result.breaking, [], `${keyword} should not be guessed at`);
  }
});

test('a changed additionalProperties subschema is reported as a notice', () => {
  const before = base(), after = base();
  requestSchema(before).additionalProperties = { type: 'string' };
  requestSchema(after).additionalProperties = { type: 'integer' };
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking, []);
  assert.ok(result.notices.some(f =>
    f.code === 'CONSTRAINT_NOT_COMPARED' && /additionalProperties` subschema changed/.test(f.message)));
});

test('constraint notices do not fire for a closed object already reported as breaking', () => {
  const before = base(), after = base();
  requestSchema(after).additionalProperties = false;
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking.map(f => f.code), ['REQUEST_OBJECT_CLOSED']);
  assert.deepEqual(result.notices, []);
});

test('zero-valued constraints are real bounds, not absent ones', () => {
  assert.ok(requestChange('name', arrayProperty({ maxItems: 5 }), arrayProperty({ maxItems: 0 }))
    .includes('REQUEST_ITEM_COUNT_NARROWED'));
  assert.ok(responseChange('name', arrayProperty({ maxItems: 0 }), arrayProperty({ maxItems: 5 }))
    .includes('RESPONSE_ITEM_COUNT_WIDENED'));
  assert.ok(requestChange('name', { maxLength: 5 }, { maxLength: 0 }).includes('REQUEST_LENGTH_NARROWED'));
  assert.ok(numericResponseChange({ exclusiveMinimum: 0 }, { minimum: 0 }).includes('RESPONSE_RANGE_WIDENED'));
  assert.deepEqual(requestChange('age', { exclusiveMinimum: 0 }, { exclusiveMinimum: 0 }), []);
});

test('a 3.0 document migrating to the 3.1 exclusive form reports nothing', () => {
  const before = base(), after = base();
  before.openapi = '3.0.3';
  after.openapi = '3.1.0';
  Object.assign(requestSchema(before).properties.age, { minimum: 1, maximum: 10, exclusiveMinimum: true, exclusiveMaximum: true });
  Object.assign(requestSchema(after).properties.age, { exclusiveMinimum: 1, exclusiveMaximum: 10 });
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking, []);
  assert.deepEqual(result.notices, []);
});

test('a 3.1 document migrating to the 3.0 boolean form reports nothing', () => {
  const before = base(), after = base();
  Object.assign(responseSchema(before).properties.id, { type: 'number', exclusiveMaximum: 10 });
  Object.assign(responseSchema(after).properties.id, { type: 'number', maximum: 10, exclusiveMaximum: true });
  assert.deepEqual(compareSpecifications(before, after).breaking, []);
});

// ===========================================================================
// Schema composition: allOf, anyOf, oneOf
// ===========================================================================

function composedRequest(schema) {
  const spec = base();
  spec.paths['/users'].post.requestBody.content['application/json'].schema = schema;
  return spec;
}

function composedResponse(schema) {
  const spec = base();
  spec.paths['/users'].get.responses['200'].content['application/json'].schema = schema;
  return spec;
}

function requestComposition(before, after) {
  return compareSpecifications(composedRequest(before), composedRequest(after));
}

function responseComposition(before, after) {
  return compareSpecifications(composedResponse(before), composedResponse(after));
}

const requestCodes = (before, after) => requestComposition(before, after).breaking.map(f => f.code);
const responseCodes = (before, after) => responseComposition(before, after).breaking.map(f => f.code);

// --- allOf: properties and required across branches -------------------------

test('allOf merges required fields from every branch', () => {
  const found = requestComposition(
    { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { properties: { b: { type: 'string' } } }] },
    { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'string' } }, required: ['b'] }] },
  );
  assert.deepEqual(found.breaking.map(f => f.code), ['REQUEST_FIELD_REQUIRED', 'REQUEST_FIELD_REQUIRED']);
  assert.deepEqual(found.breaking.map(f => f.location.split('].').pop()).sort(), ['a', 'b']);
  assert.deepEqual(found.notices, []);
});

test('a response field removed from one allOf branch is detected', () => {
  const found = responseComposition(
    { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { properties: { b: { type: 'string' } } }] },
    { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { properties: {} }] },
  );
  assert.deepEqual(found.breaking.map(f => f.code), ['RESPONSE_FIELD_REMOVED']);
  assert.ok(found.breaking[0].location.endsWith('.b'));
});

test('a property declared in two branches is intersected, not overwritten', () => {
  const found = requestComposition(
    { allOf: [{ properties: { a: { type: 'string', minLength: 1 } } }, { properties: { a: { maxLength: 10 } } }] },
    { allOf: [{ properties: { a: { type: 'string', minLength: 5 } } }, { properties: { a: { maxLength: 10 } } }] },
  );
  assert.deepEqual(found.breaking.map(f => f.code), ['REQUEST_LENGTH_NARROWED']);
  assert.ok(/Minimum length tightened/.test(found.breaking[0].message));
});

test('adding an optional property to an allOf branch stays compatible', () => {
  const found = requestComposition(
    { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }] },
    { allOf: [{ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.deepEqual(found.notices, []);
});

// --- allOf: constraints, types and enums ------------------------------------

test('allOf takes the strictest numeric bound from any branch', () => {
  const tightened = requestComposition(
    { allOf: [{ type: 'integer', minimum: 0 }, { maximum: 100 }] },
    { allOf: [{ type: 'integer', minimum: 0 }, { maximum: 50 }] },
  );
  assert.deepEqual(tightened.breaking.map(f => f.code), ['REQUEST_RANGE_NARROWED']);

  const alreadyStricter = requestComposition(
    { allOf: [{ type: 'integer', maximum: 50 }, { maximum: 100 }] },
    { allOf: [{ type: 'integer', maximum: 50 }, { maximum: 80 }] },
  );
  assert.deepEqual(alreadyStricter.breaking, [], 'relaxing a bound that was not the strictest changes nothing');
});

test('allOf applies the merged type when snapping integer bounds', () => {
  const found = requestComposition(
    { allOf: [{ type: 'integer' }, { minimum: 5 }] },
    { allOf: [{ type: 'integer' }, { exclusiveMinimum: 4 }] },
  );
  assert.deepEqual(found.breaking, [], 'an exclusive bound in one branch is equivalent on an integer schema');
});

test('allOf intersects types across branches', () => {
  const found = requestComposition(
    { allOf: [{ type: ['string', 'integer'] }, { type: ['string', 'number'] }] },
    { allOf: [{ type: ['string', 'integer'] }, { type: ['integer'] }] },
  );
  assert.deepEqual(found.breaking.map(f => f.code), ['SCHEMA_TYPE_CHANGED']);
  assert.ok(/no longer accepts string/.test(found.breaking[0].message));
});

test('allOf with non-intersecting types is reported as unmergeable', () => {
  const found = requestComposition(
    { allOf: [{ type: 'string' }, { minLength: 1 }] },
    { allOf: [{ type: 'string' }, { type: 'integer' }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.ok(found.notices.some(f =>
    f.code === 'UNSUPPORTED_COMPOSITION' && /do not intersect/.test(f.message)));
});

test('allOf intersects enums across branches', () => {
  const found = requestComposition(
    { allOf: [{ enum: ['a', 'b', 'c'] }, { enum: ['a', 'b'] }] },
    { allOf: [{ enum: ['a', 'b', 'c'] }, { enum: ['a'] }] },
  );
  assert.deepEqual(found.breaking.map(f => f.code), ['REQUEST_ENUM_NARROWED']);
  assert.ok(/"b"/.test(found.breaking[0].message));
});

test('a response enum widened inside an allOf branch is detected', () => {
  const found = responseComposition(
    { allOf: [{ type: 'string', enum: ['open'] }] },
    { allOf: [{ type: 'string', enum: ['open', 'merged'] }] },
  );
  assert.deepEqual(found.breaking.map(f => f.code), ['RESPONSE_ENUM_EXPANDED']);
});

// --- allOf: order independence ----------------------------------------------

test('reordering allOf branches is not a change', () => {
  const left = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
  const right = { properties: { b: { type: 'integer', minimum: 2 } } };
  const found = requestComposition({ allOf: [left, right] }, { allOf: [right, left] });
  assert.deepEqual(found.breaking, []);
  assert.deepEqual(found.notices, []);
});

test('nested allOf is collapsed before comparing', () => {
  const found = requestComposition(
    { allOf: [{ allOf: [{ type: 'object', properties: { a: { type: 'string' } } }] }, { required: ['a'] }] },
    { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }] },
  );
  assert.deepEqual(found.breaking, [], 'the two spellings describe the same schema');
  assert.deepEqual(found.notices, []);
});

test('composition on one side only is still compared when the merge is exact', () => {
  const found = responseComposition(
    { type: 'object', properties: { a: { type: 'string' } } },
    { allOf: [{ type: 'object' }, { properties: {} }] },
  );
  assert.deepEqual(found.breaking.map(f => f.code), ['RESPONSE_FIELD_REMOVED']);
});

// --- allOf: the additionalProperties trap -----------------------------------

test('additionalProperties: false beside the properties it governs merges safely', () => {
  const found = requestComposition(
    { allOf: [{ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, additionalProperties: false }] },
    { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }] },
  );
  assert.deepEqual(found.breaking.map(f => f.code), ['REQUEST_FIELD_REMOVED']);
  assert.deepEqual(found.notices, []);
});

test('additionalProperties: false in a different branch is never flattened', () => {
  const found = requestComposition(
    { allOf: [{ properties: { a: { type: 'string' } } }, { additionalProperties: false }] },
    { allOf: [{ properties: { a: { type: 'integer' } } }, { additionalProperties: false }] },
  );
  assert.deepEqual(found.breaking, [], 'merging here would wrongly accept the declared property');
  assert.ok(found.notices.some(f =>
    f.code === 'UNSUPPORTED_COMPOSITION' && /would reject properties declared in another/.test(f.message)));
});

test('a closing branch that covers every declared property merges safely', () => {
  const found = requestComposition(
    { allOf: [{ properties: { a: { type: 'string' }, b: {} }, additionalProperties: false }, { properties: { b: { type: 'string' } } }] },
    { allOf: [{ properties: { a: { type: 'string' }, b: {} }, additionalProperties: false }, { properties: { b: { type: 'integer' } } }] },
  );
  assert.deepEqual(found.breaking.map(f => f.code), ['SCHEMA_TYPE_CHANGED']);
  assert.ok(found.breaking[0].location.endsWith('.b'));
});

test('closing an allOf object that was open is breaking for requests', () => {
  const found = requestComposition(
    { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }] },
    { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }] },
  );
  assert.deepEqual(found.breaking.map(f => f.code), ['REQUEST_OBJECT_CLOSED']);
});

test('branches declaring different additionalProperties schemas are unmergeable', () => {
  const found = requestComposition(
    { allOf: [{ additionalProperties: { type: 'string' } }, { additionalProperties: { type: 'string' } }] },
    { allOf: [{ additionalProperties: { type: 'string' } }, { additionalProperties: { type: 'integer' } }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.ok(found.notices.some(f => f.code === 'UNSUPPORTED_COMPOSITION'));
});

// --- allOf: internal references ---------------------------------------------

test('allOf branches given as $ref are resolved and merged', () => {
  const before = {
    openapi: '3.0.3',
    components: { schemas: {
      Timestamps: { type: 'object', properties: { createdAt: { type: 'string' } }, required: ['createdAt'] },
      User: { allOf: [{ $ref: '#/components/schemas/Timestamps' }, { properties: { name: { type: 'string' } } }] },
    } },
    paths: { '/users': { get: { responses: { '200': { content: { 'application/json': {
      schema: { $ref: '#/components/schemas/User' },
    } } } } } } },
  };
  const after = structuredClone(before);
  after.components.schemas.Timestamps.required = [];
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking.map(f => f.code), ['RESPONSE_FIELD_OPTIONAL']);
  assert.ok(result.breaking[0].location.endsWith('.createdAt'));
});

test('a referenced branch that changes a nested array element is detected', () => {
  const before = {
    openapi: '3.1.0',
    components: { schemas: { Line: { type: 'object', properties: { price: { type: 'number', maximum: 10 } } } } },
    paths: { '/orders': { get: { responses: { '200': { content: { 'application/json': { schema: {
      allOf: [
        { type: 'object', properties: { lines: { type: 'array', items: { $ref: '#/components/schemas/Line' } } } },
        { required: ['lines'] },
      ],
    } } } } } } } },
  };
  const after = structuredClone(before);
  after.components.schemas.Line.properties.price.maximum = 100;
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking.map(f => f.code), ['RESPONSE_RANGE_WIDENED']);
  assert.ok(result.breaking[0].location.endsWith('.lines[].price'));
});

test('an unresolvable allOf branch is reported rather than ignored', () => {
  const found = requestComposition(
    { allOf: [{ type: 'object' }] },
    { allOf: [{ $ref: '#/components/schemas/Missing' }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.ok(found.notices.some(f => f.code === 'UNSUPPORTED_COMPOSITION'));
});

// --- allOf: keywords the engine does not evaluate ---------------------------

test('a keyword carried from a single allOf branch is still compared', () => {
  const found = requestComposition(
    { allOf: [{ type: 'string' }, { pattern: '^a$' }] },
    { allOf: [{ type: 'string' }, { pattern: '^b$' }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.ok(found.notices.some(f =>
    f.code === 'CONSTRAINT_NOT_COMPARED' && /`pattern` changed/.test(f.message)));
});

test('branches declaring conflicting unevaluated keywords are unmergeable', () => {
  const found = requestComposition(
    { allOf: [{ pattern: '^a$' }, { pattern: '^a$' }] },
    { allOf: [{ pattern: '^a$' }, { pattern: '^b$' }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.ok(found.notices.some(f =>
    f.code === 'UNSUPPORTED_COMPOSITION' && /conflicting `pattern`/.test(f.message)));
});

test('branch descriptions do not make a composition unmergeable', () => {
  const found = requestComposition(
    { allOf: [{ description: 'first', type: 'object' }, { description: 'second', properties: { a: { type: 'string' } } }] },
    { allOf: [{ description: 'changed', type: 'object' }, { description: 'also changed', properties: { a: { type: 'string' } } }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.deepEqual(found.notices, []);
});

// --- anyOf -------------------------------------------------------------------

test('reordering anyOf alternatives is not a change', () => {
  const found = requestComposition(
    { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    { anyOf: [{ type: 'integer' }, { type: 'string' }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.deepEqual(found.notices, []);
});

test('adding an anyOf alternative is compatible for requests', () => {
  const found = requestComposition(
    { anyOf: [{ type: 'string' }] },
    { anyOf: [{ type: 'string' }, { type: 'integer' }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.deepEqual(found.notices, [], 'the accepted union only grew');
});

test('adding an anyOf alternative needs review for responses', () => {
  const found = responseComposition(
    { anyOf: [{ type: 'string' }] },
    { anyOf: [{ type: 'string' }, { type: 'integer' }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.ok(found.notices.some(f =>
    f.code === 'UNSUPPORTED_COMPOSITION' && /may now return instances matching the new alternative/.test(f.message)));
});

test('removing an anyOf alternative is compatible for responses', () => {
  const found = responseComposition(
    { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    { anyOf: [{ type: 'string' }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.deepEqual(found.notices, [], 'the union of returned instances only shrank');
});

test('removing an anyOf alternative needs review for requests', () => {
  const found = requestComposition(
    { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    { anyOf: [{ type: 'string' }] },
  );
  assert.deepEqual(found.breaking, [], 'another alternative may still accept the same instances');
  assert.ok(found.notices.some(f =>
    f.code === 'UNSUPPORTED_COMPOSITION' && /cannot be established/.test(f.message)));
});

test('an anyOf alternative changed in place needs review in both directions', () => {
  for (const codes of [requestComposition, responseComposition]) {
    const found = codes(
      { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      { anyOf: [{ type: 'string' }, { type: 'boolean' }] },
    );
    assert.deepEqual(found.breaking, []);
    assert.ok(found.notices.some(f => f.code === 'UNSUPPORTED_COMPOSITION'));
  }
});

test('anyOf alternatives reached through a renamed $ref are unchanged', () => {
  const before = {
    openapi: '3.1.0',
    components: { schemas: { Old: { type: 'string', minLength: 2 } } },
    paths: { '/users': { get: { responses: { '200': { content: { 'application/json': { schema: {
      anyOf: [{ $ref: '#/components/schemas/Old' }, { type: 'integer' }],
    } } } } } } } },
  };
  const after = structuredClone(before);
  after.components.schemas.Renamed = after.components.schemas.Old;
  delete after.components.schemas.Old;
  after.paths['/users'].get.responses['200'].content['application/json'].schema.anyOf[0] = {
    $ref: '#/components/schemas/Renamed',
  };
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking, []);
  assert.deepEqual(result.notices, [], 'the alternatives resolve to the same schemas');
});

// --- oneOf -------------------------------------------------------------------

test('reordering oneOf alternatives is not a change', () => {
  const found = requestComposition(
    { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    { oneOf: [{ type: 'integer' }, { type: 'string' }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.deepEqual(found.notices, []);
});

test('adding a oneOf alternative needs review even for requests', () => {
  const found = requestComposition(
    { oneOf: [{ type: 'string' }] },
    { oneOf: [{ type: 'string' }, { minLength: 2 }] },
  );
  assert.deepEqual(found.breaking, [], 'overlap cannot be established, so nothing is claimed');
  assert.ok(found.notices.some(f =>
    f.code === 'UNSUPPORTED_COMPOSITION' && /exactly one alternative must match/.test(f.message)));
});

test('overlapping oneOf alternatives are left for review, not aggregated', () => {
  const found = responseComposition(
    { oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }] },
    {
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
      ],
    },
  );
  assert.deepEqual(found.breaking, []);
  assert.equal(found.notices.filter(f => f.code === 'UNSUPPORTED_COMPOSITION').length, 1,
    'one notice for the composition, not one per alternative');
});

test('removing a oneOf alternative needs review in both directions', () => {
  for (const comparison of [requestComposition, responseComposition]) {
    const found = comparison(
      { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      { oneOf: [{ type: 'string' }] },
    );
    assert.deepEqual(found.breaking, []);
    assert.ok(found.notices.some(f => f.code === 'UNSUPPORTED_COMPOSITION'));
  }
});

// --- composition added or removed on one side -------------------------------

test('a union added on one side only is reported for review', () => {
  const added = requestComposition({ type: 'string' }, { anyOf: [{ type: 'string' }, { type: 'integer' }] });
  assert.ok(added.notices.some(f =>
    f.code === 'UNSUPPORTED_COMPOSITION' && /`anyOf` was added/.test(f.message)));

  const removed = requestComposition({ oneOf: [{ type: 'string' }] }, { type: 'string' });
  assert.ok(removed.notices.some(f =>
    f.code === 'UNSUPPORTED_COMPOSITION' && /`oneOf` was removed/.test(f.message)));
});

test('a union sitting beside merged allOf constraints is still reported', () => {
  const found = requestComposition(
    { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { oneOf: [{ required: ['a'] }] }] },
    { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { oneOf: [{ required: ['a'] }, { required: [] }] }] },
  );
  assert.ok(found.notices.some(f => f.code === 'UNSUPPORTED_COMPOSITION' && /`oneOf`/.test(f.message)));
});

test('conflicting unions in two allOf branches are unmergeable', () => {
  const found = requestComposition(
    { allOf: [{ oneOf: [{ type: 'string' }] }, { oneOf: [{ type: 'string' }] }] },
    { allOf: [{ oneOf: [{ type: 'string' }] }, { oneOf: [{ type: 'integer' }] }] },
  );
  assert.deepEqual(found.breaking, []);
  assert.ok(found.notices.some(f =>
    f.code === 'UNSUPPORTED_COMPOSITION' && /conflicting `oneOf`/.test(f.message)));
});

// --- recursion and cycle safety ---------------------------------------------

test('a recursive schema composed with allOf terminates and is compared', () => {
  const before = {
    openapi: '3.1.0',
    components: { schemas: {
      Base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      Node: { allOf: [
        { $ref: '#/components/schemas/Base' },
        { properties: { child: { $ref: '#/components/schemas/Node' } } },
      ] },
    } },
    paths: { '/tree': { get: { responses: { '200': { content: { 'application/json': {
      schema: { $ref: '#/components/schemas/Node' },
    } } } } } } },
  };
  const after = structuredClone(before);
  after.components.schemas.Base.required = [];
  const result = compareSpecifications(before, after);
  assert.ok(result.breaking.some(f => f.code === 'RESPONSE_FIELD_OPTIONAL'));
});

test('an allOf branch referencing its own schema is reported, not looped', () => {
  const before = {
    openapi: '3.1.0',
    components: { schemas: { Loop: { allOf: [{ $ref: '#/components/schemas/Loop' }, { type: 'object' }] } } },
    paths: { '/loop': { get: { responses: { '200': { content: { 'application/json': {
      schema: { $ref: '#/components/schemas/Loop' },
    } } } } } } },
  };
  const after = structuredClone(before);
  after.components.schemas.Loop.allOf[1] = { type: 'string' };
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking, []);
  assert.ok(result.notices.some(f => f.code === 'UNSUPPORTED_COMPOSITION'));
});

test('mutually recursive composed schemas terminate', () => {
  const before = {
    openapi: '3.1.0',
    components: { schemas: {
      A: { allOf: [{ type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } }] },
      B: { allOf: [{ type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } }] },
    } },
    paths: { '/a': { get: { responses: { '200': { content: { 'application/json': {
      schema: { $ref: '#/components/schemas/A' },
    } } } } } } },
  };
  const after = structuredClone(before);
  after.components.schemas.B.allOf[0].properties.extra = { type: 'string' };
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking, [], 'adding a response field is compatible');
});

test('a recursive schema whose property merges two branches terminates', () => {
  const before = {
    openapi: '3.1.0',
    components: { schemas: { Node: { allOf: [
      { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } },
      { properties: { child: { nullable: true } } },
    ] } } },
    paths: { '/node': { get: { responses: { '200': { content: { 'application/json': {
      schema: { $ref: '#/components/schemas/Node' },
    } } } } } } },
  };
  const after = structuredClone(before);
  const result = compareSpecifications(before, after);
  assert.deepEqual(result.breaking, []);
});
