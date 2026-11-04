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
