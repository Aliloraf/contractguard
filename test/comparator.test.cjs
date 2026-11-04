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

test('composition keywords are flagged instead of silently ignored', () => {
  const before = base(), after = base();
  responseSchema(before).properties.id = { allOf: [{ type: 'string' }] };
  responseSchema(after).properties.id = { allOf: [{ type: 'integer' }] };
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
  responseSchema(before).properties.id = { allOf: [{ type: 'string' }] };
  responseSchema(after).properties.id = { allOf: [{ type: 'integer' }] };
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
