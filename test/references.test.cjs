const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');

const { compareSpecifications } = require('../.build/comparator.js');
const { loadSpecification } = require('../.build/load.js');
const {
  DEFAULT_REFERENCE_LIMITS, DocumentLoadError, EXTERNAL_FILES_KEY, foldReferences, normalizePath,
} = require('../.build/references.js');
const { createDirectorySource } = require('../.build/workspace.js');
const { createGitAccess, runGit } = require('../.build/git.js');
const { createWorkspace } = require('../.build/workspace.js');
const { runContractGuard } = require('../.build/integration.js');

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const needsGit = { skip: gitAvailable ? false : 'git is not available on PATH' };

const directories = [];
process.on('exit', () => {
  for (const directory of directories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A leftover temporary directory must never fail the run.
    }
  }
});

/** Writes `{ 'relative/path': contents }` into a fresh temporary directory. */
function tree(files) {
  const directory = mkdtempSync(join(tmpdir(), 'contractguard-refs-'));
  directories.push(directory);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return directory;
}

function load(directory, document = 'openapi.yaml', boundary = directory, documentPath = document) {
  const source = createDirectorySource(boundary, 'the test directory', 'the test directory');
  return loadSpecification(readFileSync(join(directory, document), 'utf8'), { path: documentPath, source });
}

function compareTrees(before, after) {
  return compareSpecifications(load(tree(before)), load(tree(after)));
}

const codes = list => list.map(finding => finding.code);

const HEADER = 'openapi: 3.0.3\ninfo: { title: t, version: 1.0.0 }\n';

/** A root document with one operation whose 200 response uses `schema` (YAML text). */
function root(schemaYaml, { parameters = '', extra = '' } = {}) {
  return `${HEADER}paths:
  /users:
    get:
${parameters}      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
${schemaYaml.split('\n').map(line => `                ${line}`).join('\n')}
${extra}`;
}

const USER = `type: object
required: [id]
properties:
  id: { type: string }
  name: { type: string }
`;

const USER_WITHOUT_NAME = `type: object
required: [id]
properties:
  id: { type: string }
`;

const USER_WITH_EXTRA = `${USER}  nickname: { type: string }\n`;

function loadError(files, pattern, document = 'openapi.yaml') {
  assert.throws(() => load(tree(files), document), error => {
    assert.ok(error instanceof DocumentLoadError, `expected a DocumentLoadError, got ${error}`);
    assert.match(error.message, pattern);
    return true;
  });
}

// --- the supported reference kinds -----------------------------------------------

test('a relative YAML reference is followed', () => {
  const root1 = root('$ref: ./schemas/User.yaml');
  const result = compareTrees(
    { 'openapi.yaml': root1, 'schemas/User.yaml': USER },
    { 'openapi.yaml': root1, 'schemas/User.yaml': USER_WITHOUT_NAME },
  );
  assert.deepEqual(codes(result.breaking), ['RESPONSE_FIELD_REMOVED']);
  assert.equal(result.checkedOperations, 1);
});

test('a relative JSON reference is followed', () => {
  const root1 = root('$ref: ./schemas/User.json');
  const json = schema => JSON.stringify(schema, null, '\t');
  const before = { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' } } };
  const after = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
  const result = compareTrees(
    { 'openapi.yaml': root1, 'schemas/User.json': json(before) },
    { 'openapi.yaml': root1, 'schemas/User.json': json(after) },
  );
  assert.deepEqual(codes(result.breaking), ['RESPONSE_FIELD_REMOVED']);
});

test('a document split into a path item, a schema and a shared parameter file resolves end to end', () => {
  const rootDocument = `${HEADER}paths:
  /users:
    $ref: ./paths/users.yaml
`;
  const pathItem = size => `get:
  parameters:
    - $ref: '../common/parameters.yaml#/components/parameters/PageSize'
  responses:
    '200':
      description: ok
      content:
        application/json:
          schema:
            $ref: ../schemas/Order.json
`;
  const parameters = maximum => `components:
  parameters:
    PageSize: { name: size, in: query, schema: { type: integer, maximum: ${maximum} } }
`;
  const order = JSON.stringify({ type: 'object', properties: { id: { type: 'string' } } });
  const make = maximum => ({
    'openapi.yaml': rootDocument,
    'paths/users.yaml': pathItem(),
    'common/parameters.yaml': parameters(maximum),
    'schemas/Order.json': order,
  });
  const result = compareTrees(make(100), make(10));
  assert.deepEqual(codes(result.breaking), ['REQUEST_RANGE_NARROWED']);
  assert.equal(result.breaking[0].location, 'GET /users query:size');
  assert.deepEqual(compareTrees(make(100), make(100)).breaking, []);
});

test('a whole-file reference and a pointer into the same file reach the same content', () => {
  const files = {
    'openapi.yaml': root('allOf:\n  - $ref: ./shared.yaml#/definitions/Id\n  - $ref: ./shared.yaml#/definitions/Id'),
    'shared.yaml': 'definitions:\n  Id: { type: string, minLength: 2 }\n',
  };
  const spec = load(tree(files));
  assert.ok(spec[EXTERNAL_FILES_KEY]['shared.yaml']);
  assert.equal(Object.keys(spec[EXTERNAL_FILES_KEY]).length, 1, 'the file is stored once');
});

test('the same referenced file is read once however often it is reached', () => {
  const directory = tree({
    'openapi.yaml': `${HEADER}paths:
  /a:
    get:
      responses:
        '200': { description: ok, content: { application/json: { schema: { $ref: ./schemas/A.yaml } } } }
  /b:
    get:
      responses:
        '200': { description: ok, content: { application/json: { schema: { $ref: ./schemas/B.yaml } } } }
`,
    'schemas/A.yaml': 'type: object\nproperties:\n  shared: { $ref: ./Shared.yaml }\n  again: { $ref: ./Shared.yaml#/properties/x }\n',
    'schemas/B.yaml': 'type: object\nproperties:\n  shared: { $ref: ./Shared.yaml }\n',
    'schemas/Shared.yaml': 'type: object\nproperties:\n  x: { type: string }\n',
  });
  const reads = [];
  const inner = createDirectorySource(directory, 'the test directory', 'the test directory');
  const source = { ...inner, read: (path, max) => { reads.push(path); return inner.read(path, max); } };
  loadSpecification(readFileSync(join(directory, 'openapi.yaml'), 'utf8'), { path: 'openapi.yaml', source });
  assert.deepEqual(reads.sort(), ['schemas/A.yaml', 'schemas/B.yaml', 'schemas/Shared.yaml']);
});

test('a single-file specification is returned untouched and never reads a file', () => {
  const text = root('type: string');
  const parsed = loadSpecification(text);
  let reads = 0;
  const source = { boundary: 'b', origin: 'o', read: () => { reads++; return { status: 'missing' }; } };
  const viaContext = loadSpecification(text, { path: 'openapi.yaml', source });
  assert.equal(reads, 0);
  assert.equal(EXTERNAL_FILES_KEY in viaContext, false);
  assert.deepEqual(viaContext, parsed);
});

// --- source-file context ---------------------------------------------------------

test('a nested reference resolves relative to the file that contains it, not to the root', () => {
  // `schemas/User.yaml` refers to `./address/Address.yaml`, which is
  // `schemas/address/Address.yaml`. A decoy of the same name sits beside the root.
  const make = street => ({
    'openapi.yaml': root('$ref: ./schemas/User.yaml'),
    'schemas/User.yaml': 'type: object\nproperties:\n  address: { $ref: ./address/Address.yaml }\n',
    'schemas/address/Address.yaml': `type: object\nproperties:\n  zip: { type: string }\n${street}`,
    'address/Address.yaml': 'type: object\nproperties:\n  decoy: { type: string }\n',
  });
  const result = compareTrees(make('  street: { type: string }\n'), make(''));
  assert.deepEqual(result.breaking.map(f => f.location),
    ['GET /users 200 response [application/json].address.street']);
});

test('an internal reference inside a referenced file resolves against that file, not the root', () => {
  const make = nameType => ({
    'openapi.yaml': `${root('$ref: ./models.yaml#/definitions/User', {
      extra: 'components:\n  schemas:\n    Name: { type: integer }\n',
    })}`,
    'models.yaml': `definitions:
  User:
    type: object
    properties:
      name: { $ref: '#/definitions/Name' }
  Name: { type: ${nameType} }
`,
  });
  // The root's own `Name` is an integer; the file's is the one that applies.
  const result = compareTrees(make('string'), make('integer'));
  assert.deepEqual(codes(result.breaking), ['SCHEMA_TYPE_CHANGED']);
  assert.deepEqual(compareTrees(make('string'), make('string')).breaking, []);
});

test('a reference back into the root document resolves against the root', () => {
  const files = nameType => ({
    'openapi.yaml': root('$ref: ./schemas/User.yaml', {
      extra: `components:\n  schemas:\n    Name: { type: ${nameType} }\n`,
    }),
    'schemas/User.yaml': "type: object\nproperties:\n  name: { $ref: '../openapi.yaml#/components/schemas/Name' }\n",
  });
  assert.deepEqual(codes(compareTrees(files('string'), files('integer')).breaking), ['SCHEMA_TYPE_CHANGED']);
});

test('keys that merely look like keywords are names, and $ref text in data is data', () => {
  const directory = tree({
    'openapi.yaml': root('$ref: ./s.yaml'),
    's.yaml': `type: object
properties:
  default: { $ref: ./t.yaml }
  example: { type: string, example: { $ref: ./not-a-file.yaml } }
  enum: { type: string, enum: ['./also-not-a-file.yaml'] }
  value: { type: string }
  $ref: { type: string }
x-vendor: { $ref: ./ignored.yaml }
`,
    't.yaml': 'type: integer\n',
  });
  const spec = load(directory);
  const stored = spec[EXTERNAL_FILES_KEY]['s.yaml'];
  assert.equal(stored.properties.default.$ref, `#/${EXTERNAL_FILES_KEY}/t.yaml`, 'a property named default is followed');
  assert.deepEqual(stored.properties.example.example, { $ref: './not-a-file.yaml' });
  assert.deepEqual(stored.properties.enum.enum, ['./also-not-a-file.yaml']);
  assert.deepEqual(stored['x-vendor'], { $ref: './ignored.yaml' });
  assert.deepEqual(stored.properties.$ref, { type: 'string' });
});

// --- JSON Pointer ------------------------------------------------------------------

test('escaped JSON Pointer tokens (~0 and ~1) and percent-encoding are decoded', () => {
  const files = maximum => ({
    'openapi.yaml': root('$ref: "./defs.yaml#/a~1b/c~0d/%7Bid%7D"'),
    'defs.yaml': `a/b:\n  c~d:\n    '{id}': { type: integer, maximum: ${maximum} }\n`,
  });
  const spec = load(tree(files(10)));
  assert.equal(spec.paths['/users'].get.responses['200'].content['application/json'].schema.$ref,
    `#/${EXTERNAL_FILES_KEY}/defs.yaml/a~1b/c~0d/{id}`);
  const result = compareTrees(files(10), files(20));
  assert.deepEqual(codes(result.breaking), ['RESPONSE_RANGE_WIDENED']);
});

test('a pointer may index into an array', () => {
  const make = type => ({
    'openapi.yaml': root('$ref: ./list.yaml#/items/1'),
    'list.yaml': `items:\n  - { type: string }\n  - { type: ${type} }\n`,
  });
  assert.deepEqual(codes(compareTrees(make('string'), make('integer')).breaking), ['SCHEMA_TYPE_CHANGED']);
});

test('references to non-schema components are followed: parameters, headers, responses and request bodies', () => {
  const make = ({ header, page, errorField, bodyRequired }) => ({
    'openapi.yaml': `${HEADER}paths:
  /users:
    post:
      parameters:
        - $ref: ./common.yaml#/components/parameters/Page
      requestBody:
        $ref: ./common.yaml#/components/requestBodies/Create
      responses:
        '200':
          description: ok
          headers:
            X-Rate-Limit:
              $ref: ./common.yaml#/components/headers/Rate
        '404':
          $ref: ./common.yaml#/components/responses/NotFound
`,
    'common.yaml': `components:
  parameters:
    Page: { name: page, in: query, required: ${page}, schema: { type: integer } }
  headers:
    Rate: { required: true, schema: { type: ${header} } }
  requestBodies:
    Create:
      required: ${bodyRequired}
      content:
        application/json: { schema: { type: object } }
  responses:
    NotFound:
      description: not found
      content:
        application/json:
          schema:
            type: object
            required: [message]
            properties:
              message: { type: string }
${errorField ? '              code: { type: string }\n' : ''}`,
  });
  const baseline = { header: 'integer', page: false, errorField: true, bodyRequired: false };
  assert.deepEqual(compareTrees(make(baseline), make(baseline)).breaking, []);

  const changed = compareTrees(make(baseline), make({ header: 'string', page: true, errorField: false, bodyRequired: true }));
  assert.deepEqual(codes(changed.breaking).sort(), [
    'PARAMETER_REQUIRED', 'REQUEST_BODY_REQUIRED', 'RESPONSE_FIELD_REMOVED', 'SCHEMA_TYPE_CHANGED',
  ].sort());
  assert.ok(changed.breaking.some(f => f.location.includes('404')), 'the external error response is compared');
  assert.ok(changed.breaking.some(f => f.location.includes('X-Rate-Limit')), 'the external header is compared');
});

test('an external response header removed in the referenced file is a breaking change', () => {
  const make = withHeader => ({
    'openapi.yaml': `${HEADER}paths:
  /users:
    get:
      responses:
        '200':
          $ref: ./responses.yaml#/Ok
`,
    'responses.yaml': `Ok:\n  description: ok\n${withHeader ? '  headers:\n    ETag: { schema: { type: string } }\n' : ''}`,
  });
  assert.deepEqual(codes(compareTrees(make(true), make(false)).breaking), ['RESPONSE_HEADER_REMOVED']);
});

// --- changes inside referenced files ---------------------------------------------------

test('a compatible change in a referenced schema is not reported', () => {
  const root1 = root('$ref: ./schemas/User.yaml');
  const result = compareTrees(
    { 'openapi.yaml': root1, 'schemas/User.yaml': USER },
    { 'openapi.yaml': root1, 'schemas/User.yaml': USER_WITH_EXTRA },
  );
  assert.deepEqual(result.breaking, []);
});

test('a referenced file can be moved or renamed without changing the contract', () => {
  const result = compareTrees(
    { 'openapi.yaml': root('$ref: ./schemas/User.yaml'), 'schemas/User.yaml': USER },
    { 'openapi.yaml': root('$ref: ./models/user/User.json'), 'models/user/User.json': JSON.stringify({
      type: 'object', required: ['id'], properties: { name: { type: 'string' }, id: { type: 'string' } },
    }) },
  );
  assert.deepEqual(result.breaking, []);
  assert.deepEqual(result.notices, []);
});

test('splitting a specification into files does not change what is reported', () => {
  const inline = root(USER.trimEnd());
  const split = root('$ref: ./schemas/User.yaml');
  const inlineAfter = root(USER_WITHOUT_NAME.trimEnd());
  const a = compareSpecifications(load(tree({ 'openapi.yaml': inline })), load(tree({ 'openapi.yaml': inlineAfter })));
  const b = compareTrees(
    { 'openapi.yaml': split, 'schemas/User.yaml': USER },
    { 'openapi.yaml': split, 'schemas/User.yaml': USER_WITHOUT_NAME },
  );
  assert.deepEqual(b, a);
});

test('a reference that moves the file from external to inline compares the same', () => {
  const result = compareSpecifications(
    load(tree({ 'openapi.yaml': root('$ref: ./schemas/User.yaml'), 'schemas/User.yaml': USER })),
    load(tree({ 'openapi.yaml': root(USER_WITHOUT_NAME.trimEnd()) })),
  );
  assert.deepEqual(codes(result.breaking), ['RESPONSE_FIELD_REMOVED']);
});

// --- recursion ------------------------------------------------------------------------

const TREE_A = (extra = '') => `type: object
properties:
  value: { type: string }
  children:
    type: array
    items: { $ref: ./B.yaml }
${extra}`;
const TREE_B = (extra = '') => `type: object
properties:
  label: { type: string }
  parent: { $ref: ./A.yaml }
${extra}`;

test('schemas that reference each other across files are compared, and the recursion stays finite', () => {
  const files = (a, b) => ({ 'openapi.yaml': root('$ref: ./s/A.yaml'), 's/A.yaml': a, 's/B.yaml': b });
  const same = compareTrees(files(TREE_A(), TREE_B()), files(TREE_A(), TREE_B()));
  assert.deepEqual(same.breaking, []);
  assert.deepEqual(same.notices, []);

  // A field removed two hops down the cycle is still found.
  const removed = compareTrees(
    files(TREE_A(), TREE_B()),
    files(TREE_A(), TREE_B().replace('  label: { type: string }\n', '')),
  );
  assert.deepEqual(removed.breaking.map(f => f.code), ['RESPONSE_FIELD_REMOVED']);
  assert.match(removed.breaking[0].location, /children\[\]\.label$/);
});

test('a schema that references itself through its own file is not flattened into "anything"', () => {
  const make = valueType => ({
    'openapi.yaml': root('$ref: ./Node.yaml'),
    'Node.yaml': `type: object\nproperties:\n  value: { type: ${valueType} }\n  next: { $ref: '#' }\n`,
  });
  assert.deepEqual(compareTrees(make('string'), make('string')).breaking, []);
  assert.deepEqual(codes(compareTrees(make('string'), make('integer')).breaking), ['SCHEMA_TYPE_CHANGED']);
});

test('recursion that changes shape is never reported as equivalent', () => {
  // Same names and fields, but one side's recursion goes back to the root of the
  // cycle and the other's to a different member.
  const before = {
    'openapi.yaml': root('$ref: ./A.yaml'),
    'A.yaml': 'type: object\nproperties:\n  b: { $ref: ./B.yaml }\n',
    'B.yaml': 'type: object\nproperties:\n  a: { $ref: ./A.yaml }\n',
  };
  const after = {
    'openapi.yaml': root('$ref: ./A.yaml'),
    'A.yaml': 'type: object\nproperties:\n  b: { $ref: ./B.yaml }\n',
    'B.yaml': 'type: object\nproperties:\n  a: { $ref: ./B.yaml }\n',
  };
  const result = compareTrees(before, after);
  assert.ok(result.breaking.length + result.notices.length > 0, 'a changed cycle is surfaced');
  assert.deepEqual(compareTrees(before, before).breaking, []);
});

test('a cycle made only of references is rejected with the chain named', () => {
  loadError({
    'openapi.yaml': root('$ref: ./a.yaml'),
    'a.yaml': '$ref: ./b.yaml\n',
    'b.yaml': '$ref: ./a.yaml\n',
  }, /Circular \$ref chain.*a\.yaml.*b\.yaml.*a\.yaml/);
});

// --- failures are explicit and deterministic -----------------------------------------------

test('a missing referenced file is named, with the file that refers to it and where', () => {
  loadError({
    'openapi.yaml': root('$ref: ./schemas/Missing.yaml'),
  }, /Cannot resolve \$ref "\.\/schemas\/Missing\.yaml" in openapi\.yaml \(at #\/paths\/~1users\/get\/responses\/200\/content\/application~1json\/schema\/\$ref\): "schemas\/Missing\.yaml" was not found in the test directory\./);
});

test('a missing file reached through a nested reference names the nested referrer', () => {
  loadError({
    'openapi.yaml': root('$ref: ./a/A.yaml'),
    'a/A.yaml': 'type: object\nproperties:\n  x: { $ref: ../gone.yaml }\n',
  }, /in a\/A\.yaml .*"gone\.yaml" was not found/);
});

test('a pointer that does not exist is an error naming the pointer and the file', () => {
  loadError({
    'openapi.yaml': root('$ref: ./s.yaml#/definitions/Nope'),
    's.yaml': 'definitions: { Yes: { type: string } }\n',
  }, /the pointer #\/definitions\/Nope does not exist in s\.yaml/);
});

test('an internal pointer that does not exist inside a referenced file is an error', () => {
  loadError({
    'openapi.yaml': root('$ref: ./s.yaml'),
    's.yaml': "type: object\nproperties:\n  a: { $ref: '#/definitions/Nope' }\n",
  }, /in s\.yaml .*the pointer #\/definitions\/Nope does not exist in s\.yaml/);
});

test('a pointer to something that is not an object is rejected', () => {
  loadError({
    'openapi.yaml': root('$ref: ./s.yaml#/title'),
    's.yaml': 'title: hello\n',
  }, /does not point to an object/);
});

test('a malformed pointer or percent-encoding is rejected', () => {
  loadError({ 'openapi.yaml': root('$ref: ./s.yaml#/a~2b'), 's.yaml': 'a: {}\n' }, /not a valid JSON Pointer/);
  loadError({ 'openapi.yaml': root('$ref: ./s.yaml#/a%zz'), 's.yaml': 'a: {}\n' }, /invalid percent-encoding/);
  loadError({ 'openapi.yaml': root('$ref: ./s%zz.yaml'), 's.yaml': 'a: {}\n' }, /invalid percent-encoding/);
});

test('an anchor-style fragment is reported as unsupported', () => {
  loadError({ 'openapi.yaml': root('$ref: ./s.yaml#node'), 's.yaml': 'a: {}\n' }, /anchors and named fragments are not supported/);
  loadError({
    'openapi.yaml': root('$ref: ./s.yaml'),
    's.yaml': "type: object\nproperties:\n  a: { $ref: '#node' }\n",
  }, /anchors and named fragments are not supported/);
});

test('remote and non-file references are refused without any request being made', () => {
  const cases = [
    ['https://example.test/schema.yaml', /remote references are not supported.*never fetches/],
    ['HTTP://example.test/schema.yaml#/a', /remote references are not supported/],
    ['//example.test/schema.yaml', /network-path references are not supported/],
    ['file:///etc/passwd', /"file:" URI scheme is not supported/],
    ['ftp://example.test/x.yaml', /"ftp:" URI scheme is not supported/],
    ['urn:example:schema', /"urn:" URI scheme is not supported/],
    ['/etc/passwd.yaml', /absolute paths are not supported/],
    ['C:/secrets.yaml', /absolute paths are not supported/],
    ['.\\\\win\\\\path.yaml', /backslashes are not allowed/],
    ['./s.yaml?token=1', /query strings/],
  ];
  for (const [ref, pattern] of cases) {
    loadError({ 'openapi.yaml': root(`$ref: ${JSON.stringify(ref)}`) }, pattern);
  }
});

test('unsupported file types and directories are rejected by name', () => {
  loadError({ 'openapi.yaml': root('$ref: ./s.txt'), 's.txt': 'type: string' }, /not a supported file type/);
  loadError({ 'openapi.yaml': root('$ref: ./noextension'), noextension: 'type: string' }, /not a supported file type/);
  loadError({ 'openapi.yaml': root('$ref: ./dir.yaml'), 'dir.yaml/inner.yaml': 'a: 1' }, /not a regular file/);
  loadError({ 'openapi.yaml': root('$ref: ./dir/'), 'dir/inner.yaml': 'a: 1' }, /does not name a file/);
  loadError({ 'openapi.yaml': root('$ref: ./.git/config.yaml') }, /".git"/);
});

test('malformed YAML and JSON in a referenced file are reported with the file name', () => {
  loadError({ 'openapi.yaml': root('$ref: ./bad.yaml'), 'bad.yaml': 'a: [unclosed\n' }, /"bad\.yaml" is not valid YAML or JSON/);
  loadError({ 'openapi.yaml': root('$ref: ./bad.json'), 'bad.json': '{"a": ' }, /"bad\.json" is not valid YAML or JSON/);
  loadError({ 'openapi.yaml': root('$ref: ./dup.yaml'), 'dup.yaml': 'a: 1\na: 2\n' }, /"dup\.yaml" is not valid YAML or JSON/);
  loadError({ 'openapi.yaml': root('$ref: ./scalar.yaml'), 'scalar.yaml': 'just text\n' }, /must contain an object or an array/);
});

test('a reference to the whole root document is rejected', () => {
  loadError({
    'openapi.yaml': root('$ref: ./s.yaml'),
    's.yaml': 'type: object\nproperties:\n  up: { $ref: ./openapi.yaml }\n',
  }, /whole root document/);
});

test('the reserved root key cannot be supplied by a document', () => {
  loadError({
    'openapi.yaml': `${root('$ref: ./s.yaml')}${EXTERNAL_FILES_KEY}: {}\n`,
    's.yaml': 'type: string\n',
  }, /is reserved by ContractGuard/);
});

// --- path traversal and boundaries ------------------------------------------------------

test('a reference that climbs out of the boundary is refused', () => {
  const outer = tree({ 'outside.yaml': 'type: string\n', 'api/openapi.yaml': root('$ref: ../outside.yaml') });
  assert.throws(() => load(join(outer, 'api'), 'openapi.yaml'), /resolves outside the test directory/);
  for (const ref of ['../outside.yaml', './a/../../outside.yaml', '%2e%2e/outside.yaml', 'a/%2E%2E/%2e%2e/outside.yaml']) {
    const directory = join(outer, 'api');
    writeFileSync(join(directory, 'openapi.yaml'), root(`$ref: ${JSON.stringify(ref)}`));
    assert.throws(() => load(directory), /resolves outside the test directory/, ref);
  }
});

test('a reference may climb within the boundary but not above it', () => {
  const directory = tree({
    'shared/common.yaml': 'type: string\n',
    'api/openapi.yaml': root('$ref: ../shared/common.yaml'),
  });
  // Boundary is the whole tree, and the document sits in a subdirectory.
  const spec = load(join(directory, 'api'), 'openapi.yaml', directory, 'api/openapi.yaml');
  assert.ok(spec[EXTERNAL_FILES_KEY]['shared/common.yaml']);
  // With the document's own directory as the boundary the same reference is refused.
  assert.throws(() => load(join(directory, 'api')), /resolves outside/);
});

test('the specification path itself must lie inside the boundary', () => {
  const source = { boundary: 'b', origin: 'o', read: () => ({ status: 'missing' }) };
  assert.throws(() => foldReferences({ openapi: '3.0.3', paths: {} }, '../x.yaml', source), DocumentLoadError);
  assert.equal(normalizePath('a/./b/../c'), 'a/c');
  assert.equal(normalizePath('../a'), null);
  assert.equal(normalizePath('a/../..'), null);
});

// --- symbolic links ------------------------------------------------------------------------

function trySymlink(target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false; // e.g. no privilege on Windows
  }
}

test('a symbolic link to a file is never followed, inside or outside the boundary', () => {
  const outer = tree({ 'secret.yaml': 'type: string\n', 'api/real.yaml': 'type: string\n', 'api/openapi.yaml': root('$ref: ./link.yaml') });
  const api = join(outer, 'api');
  if (!trySymlink(join(outer, 'secret.yaml'), join(api, 'link.yaml'))) return;
  assert.throws(() => load(api), /"link\.yaml" is, or passes through, a symbolic link/);

  rmSync(join(api, 'link.yaml'));
  trySymlink(join(api, 'real.yaml'), join(api, 'link.yaml'));
  assert.throws(() => load(api), /symbolic link/, 'even a link that stays inside the boundary is refused');
});

test('a path through a symbolic directory is never followed', () => {
  const outer = tree({ 'elsewhere/s.yaml': 'type: string\n', 'api/openapi.yaml': root('$ref: ./linked/s.yaml') });
  const api = join(outer, 'api');
  if (!trySymlink(join(outer, 'elsewhere'), join(api, 'linked'), 'dir')) return;
  assert.throws(() => load(api), /symbolic link/);
});

test('a dangling symbolic link is reported as a link, not followed or called missing', () => {
  const api = join(tree({ 'api/openapi.yaml': root('$ref: ./dangling.yaml') }), 'api');
  if (!trySymlink(join(api, 'nowhere.yaml'), join(api, 'dangling.yaml'))) return;
  assert.throws(() => load(api), /symbolic link/);
});

// --- limits --------------------------------------------------------------------------------

/** An in-memory source, so limit tests do not need thousands of files on disk. */
function memorySource(files) {
  return {
    boundary: 'memory',
    origin: 'memory',
    reads: 0,
    read(path) {
      this.reads++;
      return path in files ? { status: 'ok', text: files[path] } : { status: 'missing' };
    },
  };
}

function rootDocument(ref) {
  return { openapi: '3.0.3', paths: { '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: ref } } } } } } } } };
}

test('a long chain of files within the limit loads and compares', () => {
  const count = 300;
  const files = {};
  for (let index = 0; index < count; index++) {
    files[`s${index}.yaml`] = index === count - 1
      ? 'type: string\n'
      : `type: object\nproperties:\n  next: { $ref: ./s${index + 1}.yaml }\n`;
  }
  const spec = foldReferences(rootDocument('./s0.yaml'), 'openapi.yaml', memorySource(files));
  assert.equal(Object.keys(spec[EXTERNAL_FILES_KEY]).length, count);
});

test('a reference graph larger than the file limit is refused', () => {
  const files = {};
  for (let index = 0; index < 20; index++) files[`s${index}.yaml`] = `type: object\nproperties:\n  next: { $ref: ./s${index + 1}.yaml }\n`;
  const limits = { ...DEFAULT_REFERENCE_LIMITS, maxFiles: 10 };
  assert.throws(
    () => foldReferences(rootDocument('./s0.yaml'), 'openapi.yaml', memorySource(files), limits),
    /references more than 10 files/,
  );
  // The default limit is far above what a real specification needs but is finite.
  assert.ok(DEFAULT_REFERENCE_LIMITS.maxFiles >= 100 && Number.isFinite(DEFAULT_REFERENCE_LIMITS.maxFiles));
  const exactly = { ...DEFAULT_REFERENCE_LIMITS, maxFiles: 21 };
  assert.doesNotThrow(() => foldReferences(rootDocument('./s0.yaml'),
    'openapi.yaml', memorySource({ ...files, 's20.yaml': 'type: string\n' }), exactly));
});

test('a wide fan-out and a densely cross-linked graph load each file once and finish', () => {
  const count = 150;
  const files = {};
  const refs = [];
  for (let index = 0; index < count; index++) {
    refs.push(`  p${index}: { $ref: ./f${index}.yaml }`);
    // Every file references every other, which is the worst case for a loader that revisits.
    const links = [];
    for (let other = 0; other < 10; other++) links.push(`  l${other}: { $ref: ./f${(index + other + 1) % count}.yaml }`);
    files[`f${index}.yaml`] = `type: object\nproperties:\n${links.join('\n')}\n`;
  }
  files['hub.yaml'] = `type: object\nproperties:\n${refs.join('\n')}\n`;
  const source = memorySource(files);
  const spec = foldReferences(rootDocument('./hub.yaml'), 'openapi.yaml', source);
  assert.equal(source.reads, count + 1, 'each file is read exactly once');
  assert.equal(Object.keys(spec[EXTERNAL_FILES_KEY]).length, count + 1);
  const result = compareSpecifications(spec, foldReferences(rootDocument('./hub.yaml'), 'openapi.yaml', memorySource(files)));
  assert.deepEqual(result.breaking, []);
});

test('oversized files, oversized totals and runaway node counts are refused', () => {
  const big = `type: object\nproperties:\n  a: { type: string, description: "${'x'.repeat(2000)}" }\n`;
  const doc = () => rootDocument('./big.yaml');
  const source = () => memorySource({ 'big.yaml': big });
  assert.throws(() => foldReferences(doc(), 'openapi.yaml', source(), { ...DEFAULT_REFERENCE_LIMITS, maxFileBytes: 1000 }),
    /larger than the 1000 byte limit/);
  assert.throws(() => foldReferences(doc(), 'openapi.yaml', source(), { ...DEFAULT_REFERENCE_LIMITS, maxTotalBytes: 1000 }),
    /together exceed the 1000 byte limit/);
  assert.throws(() => foldReferences(doc(), 'openapi.yaml', source(), { ...DEFAULT_REFERENCE_LIMITS, maxNodes: 10 }),
    /too large to load/);
});

test('a source that reports a file over the size limit is refused, as the directory source does', () => {
  const directory = tree({ 'openapi.yaml': root('$ref: ./big.yaml'), 'big.yaml': `x: "${'y'.repeat(5000)}"\n` });
  const source = createDirectorySource(directory, 'b', 'o');
  assert.deepEqual(source.read('big.yaml', 100), { status: 'too-large', limit: 100 });
  assert.equal(source.read('big.yaml', 100000).status, 'ok');
});

test('deeply nested documents are refused instead of overflowing the stack', () => {
  const depth = 400;
  const nested = `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
  assert.throws(
    () => foldReferences(rootDocument('./deep.json'), 'openapi.yaml', memorySource({ 'deep.json': nested })),
    /nested more than \d+ levels deep/,
  );
});

test('a YAML alias bomb in a referenced file is refused', () => {
  const lines = ['a: &a [x, x, x, x, x, x, x, x, x]'];
  for (let index = 0; index < 12; index++) {
    const previous = String.fromCharCode(97 + index);
    const next = String.fromCharCode(98 + index);
    lines.push(`${next}: &${next} [${Array(9).fill(`*${previous}`).join(', ')}]`);
  }
  assert.throws(
    () => foldReferences(rootDocument('./bomb.yaml'), 'openapi.yaml', memorySource({ 'bomb.yaml': lines.join('\n') })),
    /not valid YAML or JSON/,
  );
});

test('an unreadable source is reported as unreadable, and the message is stable', () => {
  const source = { boundary: 'b', origin: 'o', read: () => ({ status: 'unreadable', detail: 'EACCES' }) };
  const attempt = () => foldReferences(rootDocument('./s.yaml'), 'openapi.yaml', source);
  assert.throws(attempt, /"s\.yaml" could not be read \(EACCES\)/);
  let first;
  let second;
  try { attempt(); } catch (error) { first = error.message; }
  try { attempt(); } catch (error) { second = error.message; }
  assert.equal(first, second);
});

// --- the CLI, end to end ------------------------------------------------------------------------

const CLI = join(__dirname, '..', '.build', 'cli.js');

function cli(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function splitProject(userYaml) {
  return {
    'openapi.yaml': root('$ref: ./schemas/User.yaml'),
    'schemas/User.yaml': userYaml,
  };
}

test('the CLI reports a breaking change that lives only in a referenced file (exit 1)', () => {
  const before = tree(splitProject(USER));
  const after = tree(splitProject(USER_WITHOUT_NAME));
  const result = cli(['--base', join(before, 'openapi.yaml'), '--head', join(after, 'openapi.yaml')]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /RESPONSE_FIELD_REMOVED/);
});

test('the CLI passes a compatible multi-file change (exit 0) and writes the report', () => {
  const before = tree(splitProject(USER));
  const after = tree(splitProject(USER_WITH_EXTRA));
  const report = join(before, 'report.md');
  const result = cli(['--base', join(before, 'openapi.yaml'), '--head', join(after, 'openapi.yaml'), '--report', report]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(report, 'utf8'), /No breaking changes/);
});

test('the CLI resolves relative paths from the current directory and each side independently', () => {
  const before = tree(splitProject(USER));
  const after = tree(splitProject(USER_WITHOUT_NAME));
  const parent = mkdtempSync(join(tmpdir(), 'contractguard-cwd-'));
  directories.push(parent);
  symlinkOrCopy(before, join(parent, 'old'));
  symlinkOrCopy(after, join(parent, 'new'));
  const result = cli(['--base', 'old/openapi.yaml', '--head', 'new/openapi.yaml'], parent);
  assert.equal(result.status, 1, result.stderr);
});

function symlinkOrCopy(from, to) {
  // A copy, not a link: the point is a relative path, and links are not followed anyway.
  const { cpSync } = require('node:fs');
  cpSync(from, to, { recursive: true });
}

test('the CLI exits 2 with a deterministic message for a missing or unsafe reference', () => {
  const good = tree(splitProject(USER));
  const missing = tree({ 'openapi.yaml': root('$ref: ./schemas/Gone.yaml') });
  const remote = tree({ 'openapi.yaml': root('$ref: https://example.test/s.yaml') });
  for (const [side, pattern] of [
    [missing, /Error: The head specification .* could not be loaded: Cannot resolve \$ref "\.\/schemas\/Gone\.yaml" in openapi\.yaml .*was not found/],
    [remote, /remote references are not supported/],
  ]) {
    const result = cli(['--base', join(good, 'openapi.yaml'), '--head', join(side, 'openapi.yaml')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, pattern);
    assert.equal(result.stderr.includes('    at '), false, 'no stack trace for an expected failure');
  }
});

test('the CLI refuses a reference outside the document directory unless a root is given', () => {
  const project = tree({
    'shared/User.yaml': USER,
    'api/openapi.yaml': root('$ref: ../shared/User.yaml'),
  });
  const refused = cli(['--base', join(project, 'api/openapi.yaml'), '--head', join(project, 'api/openapi.yaml')]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /resolves outside the directory/);

  const allowed = cli([
    '--base', join(project, 'api/openapi.yaml'), '--base-root', project,
    '--head', join(project, 'api/openapi.yaml'), '--head-root', project,
  ]);
  assert.equal(allowed.status, 0, allowed.stderr);

  const outside = cli([
    '--base', join(project, 'api/openapi.yaml'), '--base-root', join(project, 'shared'),
    '--head', join(project, 'api/openapi.yaml'),
  ]);
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /is not inside its root directory/);
});

test('single-file CLI usage and exit codes are unchanged', () => {
  const examples = join(__dirname, '..', 'examples');
  const breaking = cli(['--base', join(examples, 'before.yaml'), '--head', join(examples, 'after.yaml')]);
  assert.ok([0, 1].includes(breaking.status));
  assert.match(breaking.stdout, /ContractGuard API compatibility report/);
  assert.equal(cli([]).status, 2);
  assert.match(cli([]).stderr, /Usage:/);
});

// --- the Action against real Git history ---------------------------------------------------------

function git(cwd, args) {
  const result = runGit(cwd, args);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function newRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'contractguard-refs-git-'));
  directories.push(directory);
  git(directory, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(directory, ['config', 'user.email', 'ci@example.invalid']);
  git(directory, ['config', 'user.name', 'ContractGuard Test']);
  git(directory, ['config', 'commit.gpgsign', 'false']);
  return directory;
}

function commit(directory, message) {
  git(directory, ['add', '--all']);
  git(directory, ['commit', '--quiet', '--no-gpg-sign', '-m', message]);
  return git(directory, ['rev-parse', 'HEAD']);
}

function write(directory, files) {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

function fakeIo() {
  const record = { info: [], warning: [], outputs: {}, failed: [], summary: [] };
  return {
    record,
    io: {
      info: m => record.info.push(m),
      warning: m => record.warning.push(m),
      setOutput: (name, value) => { record.outputs[name] = value; },
      setFailed: m => record.failed.push(m),
      writeSummary: async markdown => { record.summary.push(markdown); },
    },
  };
}

async function runAction({ directory, workspace = directory, specPath = 'openapi.yaml', baseSha, headSha }) {
  const io = fakeIo();
  const outcome = await runContractGuard({
    inputs: { specPath, comment: false, githubToken: '' },
    context: { eventName: 'pull_request', pullRequest: { number: 1, baseSha, headSha, isFork: false } },
    git: createGitAccess(workspace),
    files: createWorkspace(workspace),
    io: io.io,
    comments: null,
  });
  return { outcome, io };
}

const SPLIT_ROOT = root('$ref: ./schemas/User.yaml');

test('the Action detects a breaking change in a referenced file when the root document is unchanged', needsGit, async () => {
  const directory = newRepository();
  write(directory, { 'openapi.yaml': SPLIT_ROOT, 'schemas/User.yaml': USER });
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  write(directory, { 'schemas/User.yaml': USER_WITHOUT_NAME });
  const headSha = commit(directory, 'drop a field in the schema file only');

  assert.equal(git(directory, ['diff', '--name-only', baseSha, headSha]), 'schemas/User.yaml', 'the root really is unchanged');
  const { outcome, io } = await runAction({ directory, baseSha, headSha });
  assert.equal(outcome.status, 'breaking', JSON.stringify(outcome.error));
  assert.equal(outcome.breakingCount, 1);
  assert.match(outcome.report, /RESPONSE_FIELD_REMOVED/);
  assert.equal(io.record.outputs.breaking, 'true');
});

test('the Action passes a compatible change in a referenced file', needsGit, async () => {
  const directory = newRepository();
  write(directory, { 'openapi.yaml': SPLIT_ROOT, 'schemas/User.yaml': USER });
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  write(directory, { 'schemas/User.yaml': USER_WITH_EXTRA });
  const headSha = commit(directory, 'add an optional field');
  const { outcome } = await runAction({ directory, baseSha, headSha });
  assert.equal(outcome.status, 'compatible', outcome.error ?? '');
});

test('the baseline reads every dependency from the baseline revision, never from the working tree', needsGit, async () => {
  // At the base the schema has `name`. On the feature branch the same path loses
  // it. If the baseline were read from the checkout, both sides would match.
  const directory = newRepository();
  write(directory, {
    'openapi.yaml': root('$ref: ./schemas/User.yaml'),
    'schemas/User.yaml': "type: object\nproperties:\n  id: { type: string }\n  name: { $ref: './Name.yaml' }\n",
    'schemas/Name.yaml': 'type: string\n',
  });
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  write(directory, { 'schemas/Name.yaml': 'type: integer\n' });
  const headSha = commit(directory, 'retype the nested schema');
  const { outcome } = await runAction({ directory, baseSha, headSha });
  assert.equal(outcome.status, 'breaking');
  assert.match(outcome.report, /SCHEMA_TYPE_CHANGED/);
});

test('files added, renamed and removed between revisions resolve per side', needsGit, async () => {
  const directory = newRepository();
  write(directory, { 'openapi.yaml': SPLIT_ROOT, 'schemas/User.yaml': USER });
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  // The schema moves to a new directory and the old file disappears: the head
  // must not look for `schemas/User.yaml`, nor the baseline for `models/User.yaml`.
  git(directory, ['rm', '--quiet', 'schemas/User.yaml']);
  write(directory, {
    'openapi.yaml': root('$ref: ./models/User.yaml'),
    'models/User.yaml': USER_WITH_EXTRA,
  });
  const headSha = commit(directory, 'move the schema');
  const { outcome } = await runAction({ directory, baseSha, headSha });
  assert.equal(outcome.status, 'compatible', outcome.error ?? '');
});

test('the baseline is the merge base: a referenced file changed on the base branch is not blamed on the pull request', needsGit, async () => {
  const directory = newRepository();
  write(directory, { 'openapi.yaml': SPLIT_ROOT, 'schemas/User.yaml': USER });
  const forkPoint = commit(directory, 'fork point');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  write(directory, { 'schemas/User.yaml': USER_WITH_EXTRA });
  const headSha = commit(directory, 'feature adds a field');
  git(directory, ['checkout', '--quiet', 'main']);
  write(directory, { 'schemas/User.yaml': USER_WITHOUT_NAME });
  const baseTip = commit(directory, 'base branch drops a field');
  git(directory, ['checkout', '--quiet', 'feature']);

  const { outcome } = await runAction({ directory, baseSha: baseTip, headSha });
  assert.equal(outcome.baselineSha, forkPoint);
  assert.equal(outcome.status, 'compatible', outcome.error ?? '');
});

test('the Action resolves references for a specification in a subdirectory, up to the repository root', needsGit, async () => {
  const directory = newRepository();
  write(directory, {
    'services/users/openapi.yaml': root('$ref: ../../shared/User.yaml'),
    'shared/User.yaml': USER,
  });
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  write(directory, { 'shared/User.yaml': USER_WITHOUT_NAME });
  const headSha = commit(directory, 'shared change');
  for (const workspace of [directory, join(directory, 'services', 'users')]) {
    const { outcome } = await runAction({
      directory, workspace, specPath: workspace === directory ? 'services/users/openapi.yaml' : 'openapi.yaml', baseSha, headSha,
    });
    assert.equal(outcome.status, 'breaking', outcome.error ?? '');
  }
});

test('the Action refuses a reference that leaves the repository', needsGit, async () => {
  const directory = newRepository();
  write(directory, { 'api/openapi.yaml': root('$ref: ../../outside.yaml') });
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  write(directory, { 'api/openapi.yaml': `${root('$ref: ../../outside.yaml')}\n# touched\n` });
  const headSha = commit(directory, 'touch');
  const { outcome } = await runAction({ directory, specPath: 'api/openapi.yaml', baseSha, headSha });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /could not be read: Cannot resolve \$ref ".*outside\.yaml".*resolves outside the repository/);
});

test('the Action fails, rather than passes, when a referenced file is missing on either side', needsGit, async () => {
  const directory = newRepository();
  write(directory, { 'openapi.yaml': SPLIT_ROOT, 'schemas/User.yaml': USER });
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  git(directory, ['rm', '--quiet', 'schemas/User.yaml']);
  const headSha = commit(directory, 'delete the schema but keep the reference');
  const head = await runAction({ directory, baseSha, headSha });
  assert.equal(head.outcome.status, 'failed');
  assert.match(head.outcome.error, /from this pull request could not be read: .*"schemas\/User\.yaml" was not found in this pull request/);

  // And the baseline side: the base lacks the file the head references.
  const second = newRepository();
  write(second, { 'openapi.yaml': SPLIT_ROOT });
  const base2 = commit(second, 'base without the schema');
  git(second, ['checkout', '--quiet', '-b', 'feature']);
  write(second, { 'schemas/User.yaml': USER });
  const head2 = commit(second, 'add the schema');
  const result = await runAction({ directory: second, baseSha: base2, headSha: head2 });
  assert.equal(result.outcome.status, 'failed');
  assert.match(result.outcome.error, /from the base commit [0-9a-f]{7} could not be read: .*was not found in the base commit/);
});

test('a symbolic link committed at the baseline is refused, not read as the path text', needsGit, async () => {
  const directory = newRepository();
  write(directory, { 'openapi.yaml': SPLIT_ROOT, 'real/User.yaml': USER });
  if (!trySymlink('real/User.yaml', join(directory, 'schemas-link.yaml'))) return;
  write(directory, { 'openapi.yaml': root('$ref: ./schemas-link.yaml') });
  const baseSha = commit(directory, 'base uses a symlink');
  assert.equal(git(directory, ['ls-tree', baseSha, 'schemas-link.yaml']).startsWith('120000'), true);
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  git(directory, ['rm', '--quiet', 'schemas-link.yaml']);
  write(directory, { 'openapi.yaml': root('$ref: ./real/User.yaml') });
  const headSha = commit(directory, 'replace the link');
  const { outcome } = await runAction({ directory, baseSha, headSha });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /base commit.*symbolic link/);
});

test('a path through a symbolic directory committed at the baseline is refused', needsGit, async () => {
  const directory = newRepository();
  write(directory, { 'real/User.yaml': USER });
  if (!trySymlink('real', join(directory, 'linked'), 'dir')) return;
  write(directory, { 'openapi.yaml': root('$ref: ./linked/User.yaml') });
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  write(directory, { 'openapi.yaml': `${root('$ref: ./linked/User.yaml')}\n# touched\n` });
  const headSha = commit(directory, 'touch');
  const { outcome } = await runAction({ directory, baseSha, headSha });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /symbolic link/);
});

test('a symbolic link in the checkout is refused for the head side', needsGit, async () => {
  const directory = newRepository();
  write(directory, { 'openapi.yaml': SPLIT_ROOT, 'schemas/User.yaml': USER, 'elsewhere/User.yaml': USER_WITHOUT_NAME });
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  git(directory, ['rm', '--quiet', 'schemas/User.yaml']);
  if (!trySymlink(join(directory, 'elsewhere', 'User.yaml'), join(directory, 'schemas', 'User.yaml'))) return;
  const headSha = commit(directory, 'replace the schema with a link');
  const { outcome } = await runAction({ directory, baseSha, headSha });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /this pull request.*symbolic link/);
});

test('remote references fail the Action without a network request', needsGit, async () => {
  const directory = newRepository();
  write(directory, { 'openapi.yaml': SPLIT_ROOT, 'schemas/User.yaml': USER });
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  write(directory, { 'openapi.yaml': root('$ref: https://example.test/User.yaml') });
  const headSha = commit(directory, 'point at a remote schema');
  const { outcome } = await runAction({ directory, baseSha, headSha });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /remote references are not supported/);
});

test('a path with shell metacharacters in a reference is read literally', needsGit, async () => {
  const directory = newRepository();
  const name = 'we ird$(touch pwned);`x`&name.yaml';
  write(directory, { 'openapi.yaml': root(`$ref: ${JSON.stringify(encodeURI(`./${name}`).replace(/;/g, '%3B'))}`), [name]: USER });
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  write(directory, { [name]: USER_WITHOUT_NAME });
  const headSha = commit(directory, 'change');
  const { outcome } = await runAction({ directory, baseSha, headSha });
  assert.equal(outcome.status, 'breaking', outcome.error ?? '');
  assert.equal(require('node:fs').existsSync(join(directory, 'pwned')), false);
});

test('file names containing glob characters or pathspec magic are matched literally', needsGit, async () => {
  const directory = newRepository();
  const names = ['sch*ma [1]?.yaml', ':(top)User.yaml'];
  for (const name of names) {
    write(directory, { 'openapi.yaml': root(`$ref: ${JSON.stringify(`./${encodeURIComponent(name)}`)}`), [name]: USER });
    const baseSha = commit(directory, `base ${name}`);
    git(directory, ['checkout', '--quiet', '-b', `feature-${names.indexOf(name)}`]);
    write(directory, { [name]: USER_WITHOUT_NAME });
    const headSha = commit(directory, `change ${name}`);
    const { outcome } = await runAction({ directory, baseSha, headSha });
    assert.equal(outcome.status, 'breaking', `${name}: ${outcome.error}`);
    git(directory, ['checkout', '--quiet', 'main']);
  }
});

test('single-file Action usage never touches the reference readers', async () => {
  // The in-memory environment of the integration tests has no `entryAt` or `source`:
  // a specification without external references must not need either.
  const files = { '/work/openapi.yaml': root('type: string') };
  const commits = { [`${'a'.repeat(40)}`]: { 'openapi.yaml': root('type: string') }, [`${'b'.repeat(40)}`]: {} };
  const io = fakeIo();
  const outcome = await runContractGuard({
    inputs: { specPath: 'openapi.yaml', comment: false, githubToken: '' },
    context: { eventName: 'pull_request', pullRequest: { number: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), isFork: false } },
    git: {
      repositoryRoot: () => '/work',
      resolveCommit: revision => (revision === 'HEAD' ? 'b'.repeat(40) : revision),
      commitExists: sha => sha in commits,
      mergeBase: left => left,
      fileExistsAt: (sha, path) => path in commits[sha],
      readFileAt: (sha, path) => commits[sha][path],
    },
    files: {
      isAbsolute: path => path.startsWith('/'),
      resolve: path => `/work/${path}`,
      relativeTo: (base, absolute) => absolute.slice(base.length + 1),
      exists: absolute => absolute in files,
      read: absolute => files[absolute],
    },
    io: io.io,
    comments: null,
  });
  assert.equal(outcome.status, 'compatible', outcome.error ?? '');
});
