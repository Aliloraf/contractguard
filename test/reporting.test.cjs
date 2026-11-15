const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync, lstatSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const Ajv = require('ajv');
const Ajv04 = require('ajv-draft-04');

const { compareSpecifications } = require('../.build/comparator.js');
const { loadSpecification } = require('../.build/load.js');
const { renderMarkdown } = require('../.build/report.js');
const { RULES } = require('../.build/rules.js');
const { TOOL_NAME, TOOL_VERSION, TOOL_URI } = require('../.build/version.js');
const { buildJsonReport, renderJson, JSON_REPORT_SCHEMA_VERSION } = require('../.build/json-report.js');
const { buildSarif, renderSarif, SARIF_SCHEMA, SARIF_VERSION } = require('../.build/sarif.js');
const { renderReport, isReportFormat, REPORT_FORMATS } = require('../.build/report-format.js');
const { orderFindings } = require('../.build/report-model.js');
const { createDirectorySource, writeRepositoryFile } = require('../.build/workspace.js');
const { createGitAccess, runGit } = require('../.build/git.js');
const { createWorkspace } = require('../.build/workspace.js');
const { runContractGuard } = require('../.build/integration.js');

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const needsGit = { skip: gitAvailable ? false : 'git is not available on PATH' };

// --- validators ------------------------------------------------------------------------
// The SARIF check runs against the official OASIS schema for 2.1.0 (a copy lives in
// test/fixtures), not against anything written for this project. Formats are not
// validated by the schema library, so the URI-valued fields are asserted separately.

const sarifSchema = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'sarif-schema-2.1.0.json'), 'utf8'));
const validateSarifSchema = new Ajv04({ strict: false, validateFormats: false, allErrors: true }).compile(sarifSchema);
const reportSchema = JSON.parse(readFileSync(join(__dirname, '..', 'schema', 'report-1.0.schema.json'), 'utf8'));
const validateReportSchema = new Ajv({ strict: false, allErrors: true }).compile(reportSchema);

function assertSarifValid(log) {
  const ok = validateSarifSchema(log);
  assert.ok(ok, `SARIF does not conform to the 2.1.0 schema: ${JSON.stringify(validateSarifSchema.errors, null, 1)}`);
}

function assertReportValid(report) {
  const ok = validateReportSchema(report);
  assert.ok(ok, `JSON report does not conform to its schema: ${JSON.stringify(validateReportSchema.errors, null, 1)}`);
}

// --- fixtures ----------------------------------------------------------------------------

const finding = (code, location, message) => ({ code, location, message });

const COMPATIBLE = { breaking: [], notices: [], checkedOperations: 4 };

const MIXED = {
  breaking: [
    finding('RESPONSE_FIELD_REMOVED', 'GET /users 200 response [application/json].name', 'Response field removed.'),
    finding('OPERATION_REMOVED', 'DELETE /users/{id}', 'Previously available endpoint removed.'),
    finding('REQUEST_RANGE_NARROWED', 'GET /users query:size', 'Maximum tightened (<= 100 → <= 50); requests that were valid are now rejected.'),
  ],
  notices: [
    finding('CONSTRAINT_NOT_COMPARED', 'GET /users 200 response [application/json].id', 'pattern changed | "quoted" text'),
    finding('RESPONSE_STATUS_ADDED', 'GET /users 404', 'A status was added.'),
  ],
  checkedOperations: 7,
};

const NOTICES_ONLY = { breaking: [], notices: [MIXED.notices[0]], checkedOperations: 1 };

const CONTEXT = {
  baseline: { path: 'api/openapi.yaml', revision: 'a'.repeat(40) },
  head: { path: 'api/openapi.yaml', revision: 'b'.repeat(40) },
};

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

function tree(files) {
  const directory = mkdtempSync(join(tmpdir(), 'contractguard-report-'));
  directories.push(directory);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return directory;
}

const HEADER = 'openapi: 3.0.3\ninfo: { title: t, version: 1.0.0 }\n';

function api({ fields = ['id', 'name', 'tag'], maximum = 100, pattern = '^a' } = {}) {
  const properties = fields.map(name => `                  ${name}: { type: string${name === 'name' ? `, pattern: '${pattern}'` : ''} }`).join('\n');
  return `${HEADER}paths:
  /users:
    get:
      parameters:
        - { name: size, in: query, schema: { type: integer, maximum: ${maximum} } }
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [id]
                properties:
${properties}
`;
}

function compare(beforeText, afterText) {
  return compareSpecifications(loadSpecification(beforeText), loadSpecification(afterText));
}

/** A real comparison with both kinds of finding. */
const REAL = compare(api(), api({ fields: ['id', 'name'], maximum: 50, pattern: '^b' }));

// --- the rule catalogue -----------------------------------------------------------------

const { readdirSync: ls } = require('node:fs');

function sourceCodes() {
  const kinds = new Map();
  const dir = join(__dirname, '..', 'src');
  for (const file of ls(dir).filter(name => name.endsWith('.ts') && name !== 'rules.ts')) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const match of text.matchAll(/(breaking|notice)\(\s*'([A-Z][A-Z0-9_]*)'/g)) kinds.set(match[2], match[1]);
    for (const match of text.matchAll(/'([A-Z]+(?:_[A-Z0-9]+)+)'/g)) if (!kinds.has(match[1])) kinds.set(match[1], null);
  }
  return kinds;
}

test('every rule code the engine can emit has a catalogue entry, and the catalogue has no stale entries', () => {
  const emitted = sourceCodes();
  assert.ok(emitted.size >= 30, 'the scan found the rule codes');
  assert.deepEqual([...emitted.keys()].sort(), Object.keys(RULES).sort());
});

test('the catalogue agrees with how the engine reports each code', () => {
  for (const [code, kind] of sourceCodes()) {
    if (kind !== null) assert.equal(RULES[code].kind, kind, `${code} is reported as a ${kind}`);
  }
  // Codes passed through a variable (the range, length and item-count families) are all breaking.
  for (const code of ['REQUEST_RANGE_NARROWED', 'RESPONSE_RANGE_WIDENED', 'REQUEST_LENGTH_NARROWED',
    'RESPONSE_LENGTH_WIDENED', 'REQUEST_ITEM_COUNT_NARROWED', 'RESPONSE_ITEM_COUNT_WIDENED']) {
    assert.equal(RULES[code].kind, 'breaking');
  }
  for (const [code, info] of Object.entries(RULES)) {
    assert.match(code, /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
    assert.ok(info.title.length > 3 && info.description.endsWith('.'), `${code} is described`);
  }
});

test('the reported tool version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(TOOL_VERSION, pkg.version);
  assert.equal(TOOL_NAME, 'ContractGuard');
  assert.equal(TOOL_URI, pkg.homepage.replace(/#readme$/, ''));
});

// --- JSON ---------------------------------------------------------------------------------

test('a compatible JSON report is complete and empty of findings', () => {
  const report = JSON.parse(renderJson(COMPATIBLE, CONTEXT));
  assert.deepEqual(report, {
    schemaVersion: '1.0',
    tool: { name: 'ContractGuard', version: TOOL_VERSION, informationUri: TOOL_URI },
    comparison: {
      baseline: { path: 'api/openapi.yaml', revision: 'a'.repeat(40) },
      head: { path: 'api/openapi.yaml', revision: 'b'.repeat(40) },
    },
    summary: { status: 'compatible', breaking: 0, notices: 0, checkedOperations: 4 },
    breaking: [],
    notices: [],
    rules: [],
  });
  assertReportValid(report);
  assert.equal(JSON_REPORT_SCHEMA_VERSION, '1.0');
});

test('a JSON report keeps breaking findings and notices apart, with severity, code, location and message', () => {
  const report = JSON.parse(renderJson(MIXED, CONTEXT));
  assertReportValid(report);
  assert.equal(report.summary.status, 'breaking');
  assert.deepEqual([report.summary.breaking, report.summary.notices, report.summary.checkedOperations], [3, 2, 7]);
  assert.ok(report.breaking.every(f => f.severity === 'error'));
  assert.ok(report.notices.every(f => f.severity === 'warning'));
  assert.deepEqual(report.breaking[0], {
    code: 'OPERATION_REMOVED',
    severity: 'error',
    location: 'DELETE /users/{id}',
    message: 'Previously available endpoint removed.',
  });
  assert.equal(report.notices[0].message, 'pattern changed | "quoted" text', 'messages are not escaped for Markdown');
  assert.deepEqual(report.rules.map(rule => rule.code), [
    'CONSTRAINT_NOT_COMPARED', 'OPERATION_REMOVED', 'REQUEST_RANGE_NARROWED', 'RESPONSE_FIELD_REMOVED', 'RESPONSE_STATUS_ADDED',
  ], 'only the rules that fired, in code order');
  assert.deepEqual(report.rules[1], {
    code: 'OPERATION_REMOVED', kind: 'breaking', severity: 'error',
    title: RULES.OPERATION_REMOVED.title, description: RULES.OPERATION_REMOVED.description,
  });
});

test('notices alone leave the status compatible', () => {
  const report = JSON.parse(renderJson(NOTICES_ONLY, CONTEXT));
  assert.equal(report.summary.status, 'compatible');
  assert.equal(report.summary.notices, 1);
  assertReportValid(report);
});

test('a real comparison produces a valid report whose findings are the comparator\'s own', () => {
  assert.ok(REAL.breaking.length >= 2 && REAL.notices.length >= 1, 'the fixture exercises both lists');
  const report = JSON.parse(renderJson(REAL, CONTEXT));
  assertReportValid(report);
  const pick = list => list.map(({ code, location, message }) => ({ code, location, message }));
  assert.deepEqual(pick(report.breaking), pick(orderFindings(REAL.breaking)));
  assert.deepEqual(pick(report.notices), pick(orderFindings(REAL.notices)));
});

test('JSON output is deterministic: same bytes regardless of the order findings arrive in', () => {
  const shuffled = {
    ...MIXED,
    breaking: [...MIXED.breaking].reverse(),
    notices: [...MIXED.notices].reverse(),
  };
  const first = renderJson(MIXED, CONTEXT);
  assert.equal(renderJson(shuffled, CONTEXT), first);
  assert.equal(renderJson(MIXED, CONTEXT), first);
  assert.ok(first.endsWith('}\n') && !first.endsWith('\n\n'));
  assert.equal(JSON.stringify(JSON.parse(first), null, 2) + '\n', first, 'serialisation round-trips exactly');
  assert.deepEqual(Object.keys(JSON.parse(first)),
    ['schemaVersion', 'tool', 'comparison', 'summary', 'breaking', 'notices', 'rules'], 'key order is fixed');
  assert.deepEqual(Object.keys(JSON.parse(first).breaking[0]), ['code', 'severity', 'location', 'message']);
});

test('findings are ordered by code point, not by the machine locale', () => {
  const list = ['b', 'a', 'Z', 'B', '_'].map(location => finding('X_RULE', location, 'm'));
  assert.deepEqual(orderFindings(list).map(f => f.location), ['B', 'Z', '_', 'a', 'b']);
  const sameLocation = [finding('B_RULE', 'x', 'm'), finding('A_RULE', 'x', 'z'), finding('A_RULE', 'x', 'a')];
  assert.deepEqual(orderFindings(sameLocation).map(f => `${f.code}:${f.message}`), ['A_RULE:a', 'A_RULE:z', 'B_RULE:m']);
});

test('the report context is optional and a missing side is null, never invented', () => {
  const report = JSON.parse(renderJson(COMPATIBLE, { baseline: null, head: null }));
  assert.deepEqual(report.comparison, { baseline: null, head: null });
  assertReportValid(report);
  assert.deepEqual(buildJsonReport(COMPATIBLE, { baseline: { path: 'a.yaml', revision: null }, head: null }).comparison.baseline,
    { path: 'a.yaml', revision: null });
});

test('the JSON schema rejects a tampered report, so the validator is doing real work', () => {
  const report = JSON.parse(renderJson(MIXED, CONTEXT));
  assert.equal(validateReportSchema({ ...report, extra: true }), false);
  assert.equal(validateReportSchema({ ...report, schemaVersion: '2.0' }), false);
  assert.equal(validateReportSchema({ ...report, breaking: [{ ...report.breaking[0], severity: 'fatal' }] }), false);
});

test('an unknown rule code is still reported, with a generic description', () => {
  const result = { breaking: [finding('FUTURE_RULE', 'GET /x', 'something')], notices: [], checkedOperations: 1 };
  const report = JSON.parse(renderJson(result, CONTEXT));
  assertReportValid(report);
  assert.equal(report.rules[0].code, 'FUTURE_RULE');
  assert.equal(report.rules[0].title, 'FUTURE_RULE');
  const sarif = JSON.parse(renderSarif(result, CONTEXT));
  assertSarifValid(sarif);
  const rule = sarif.runs[0].tool.driver.rules.find(r => r.id === 'FUTURE_RULE');
  assert.equal(rule.defaultConfiguration.level, 'error');
  assert.equal(sarif.runs[0].results[0].ruleIndex, sarif.runs[0].tool.driver.rules.indexOf(rule));
});

// --- SARIF ----------------------------------------------------------------------------------

test('SARIF output conforms to the official SARIF 2.1.0 schema in every shape', () => {
  for (const [name, result] of Object.entries({ compatible: COMPATIBLE, notices: NOTICES_ONLY, mixed: MIXED, real: REAL })) {
    for (const context of [CONTEXT, { baseline: null, head: null }, { ...CONTEXT, physicalLocationUri: 'api/openapi.yaml' }]) {
      assertSarifValid(JSON.parse(renderSarif(result, context)));
      assert.ok(name);
    }
  }
});

test('the SARIF schema rejects a tampered log, so the validator is doing real work', () => {
  const log = JSON.parse(renderSarif(MIXED, CONTEXT));
  const broken = JSON.parse(JSON.stringify(log));
  broken.runs[0].results[0].level = 'fatal';
  assert.equal(validateSarifSchema(broken), false);
  const noVersion = JSON.parse(JSON.stringify(log));
  delete noVersion.version;
  assert.equal(validateSarifSchema(noVersion), false);
  const wrongVersion = JSON.parse(JSON.stringify(log));
  wrongVersion.version = '2.0.0';
  assert.equal(validateSarifSchema(wrongVersion), false);
});

test('SARIF identifies itself and the tool correctly', () => {
  const log = JSON.parse(renderSarif(MIXED, CONTEXT));
  assert.equal(log.version, '2.1.0');
  assert.equal(SARIF_VERSION, '2.1.0');
  assert.equal(log.$schema, SARIF_SCHEMA);
  assert.match(log.$schema, /^https:\/\/docs\.oasis-open\.org\/sarif\/sarif\/v2\.1\.0\/.*sarif-schema-2\.1\.0\.json$/);
  assert.equal(log.runs.length, 1);
  const driver = log.runs[0].tool.driver;
  assert.equal(driver.name, 'ContractGuard');
  assert.equal(driver.version, TOOL_VERSION);
  assert.equal(driver.semanticVersion, TOOL_VERSION);
  assert.equal(new URL(driver.informationUri).protocol, 'https:');
  assert.deepEqual(log.runs[0].invocations, [{ executionSuccessful: true }], 'finding breakage is not a tool failure');
});

test('SARIF rules are stable, unique, documented and carry the right severity', () => {
  const log = JSON.parse(renderSarif(COMPATIBLE, CONTEXT));
  const rules = log.runs[0].tool.driver.rules;
  assert.deepEqual(rules.map(rule => rule.id), Object.keys(RULES).sort(), 'every known rule, in code order');
  assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length);
  for (const rule of rules) {
    const info = RULES[rule.id];
    assert.equal(rule.shortDescription.text, info.title);
    assert.equal(rule.fullDescription.text, info.description);
    assert.ok(rule.help.text.includes(info.description));
    assert.equal(new URL(rule.helpUri).hostname, 'github.com');
    assert.equal(rule.defaultConfiguration.level, info.kind === 'breaking' ? 'error' : 'warning');
    assert.ok(rule.properties.tags.includes('api-compatibility'));
    assert.ok(rule.properties.tags.includes(info.kind === 'breaking' ? 'breaking-change' : 'review-required'));
  }
  // The rule list does not depend on which findings fired.
  const other = JSON.parse(renderSarif(MIXED, CONTEXT)).runs[0].tool.driver.rules;
  assert.deepEqual(other, rules);
  assert.equal(rules.find(rule => rule.id === 'OPERATION_REMOVED').name, 'OperationRemoved');
});

test('SARIF results map breaking findings to error and review notices to warning', () => {
  const run = JSON.parse(renderSarif(MIXED, CONTEXT)).runs[0];
  assert.equal(run.results.length, 5);
  const rules = run.tool.driver.rules;
  for (const result of run.results) {
    assert.equal(rules[result.ruleIndex].id, result.ruleId, 'ruleIndex points at ruleId');
    const expected = RULES[result.ruleId].kind === 'breaking' ? 'error' : 'warning';
    assert.equal(result.level, expected);
    assert.equal(result.properties.kind, RULES[result.ruleId].kind);
    assert.equal(result.message.text.startsWith(result.locations[0].logicalLocations[0].fullyQualifiedName), true);
  }
  assert.deepEqual(run.results.map(r => r.level), ['error', 'error', 'error', 'warning', 'warning'], 'breaking first');
  assert.equal(run.results[0].message.text, 'DELETE /users/{id}: Previously available endpoint removed.');
  assert.deepEqual(run.properties, { checkedOperations: 7, baseline: CONTEXT.baseline, head: CONTEXT.head });
});

test('a compatible SARIF log has an empty results array, not a missing one', () => {
  const run = JSON.parse(renderSarif(COMPATIBLE, CONTEXT)).runs[0];
  assert.deepEqual(run.results, []);
  assert.equal(run.invocations[0].executionSuccessful, true);
});

test('SARIF uses logical locations only, and never invents a file, line or column', () => {
  const text = renderSarif(MIXED, CONTEXT);
  const run = JSON.parse(text).runs[0];
  for (const result of run.results) {
    assert.equal(result.locations.length, 1);
    const [location] = result.locations;
    assert.equal('physicalLocation' in location, false);
    assert.equal(location.logicalLocations.length, 1);
    const logical = location.logicalLocations[0];
    assert.ok(logical.name && logical.fullyQualifiedName && logical.kind);
  }
  assert.deepEqual(run.results[0].locations[0].logicalLocations[0], {
    name: 'DELETE /users/{id}', fullyQualifiedName: 'DELETE /users/{id}', kind: 'resource',
  });
  for (const forbidden of ['"region"', '"startLine"', '"startColumn"', '"physicalLocation"', '"artifactLocation"']) {
    assert.equal(text.includes(forbidden), false, `no ${forbidden} without a known file`);
  }
});

test('a physical location is file-level only, and only when the caller supplies the file', () => {
  const text = renderSarif(MIXED, { ...CONTEXT, physicalLocationUri: 'api/openapi.yaml' });
  const run = JSON.parse(text).runs[0];
  for (const result of run.results) {
    assert.deepEqual(result.locations[0].physicalLocation, { artifactLocation: { uri: 'api/openapi.yaml' } });
    assert.equal(result.locations[0].logicalLocations.length, 1, 'the logical location stays');
  }
  assert.equal(text.includes('"region"'), false);
  assert.equal(text.includes('"startLine"'), false);
  assertSarifValid(JSON.parse(text));
  assert.equal(JSON.stringify(JSON.parse(renderSarif(MIXED, { ...CONTEXT, physicalLocationUri: null }))).includes('physicalLocation'), false);
  assert.equal(JSON.stringify(JSON.parse(renderSarif(MIXED, { ...CONTEXT, physicalLocationUri: '' }))).includes('physicalLocation'), false);
});

test('SARIF fingerprints are stable, distinct per finding and independent of order', () => {
  const first = JSON.parse(renderSarif(MIXED, CONTEXT)).runs[0].results;
  const reversed = JSON.parse(renderSarif({ ...MIXED, breaking: [...MIXED.breaking].reverse() }, CONTEXT)).runs[0].results;
  assert.deepEqual(first.map(r => r.partialFingerprints), reversed.map(r => r.partialFingerprints));
  const prints = first.map(r => r.partialFingerprints['contractguard/v1']);
  assert.equal(new Set(prints).size, prints.length);
  for (const print of prints) assert.match(print, /^[0-9a-f]{64}$/);
  // Changing the revision or the specification path must not change a finding's identity.
  const other = JSON.parse(renderSarif(MIXED, { baseline: null, head: null })).runs[0].results;
  assert.deepEqual(other.map(r => r.partialFingerprints), first.map(r => r.partialFingerprints));
});

test('SARIF output is deterministic and carries no timestamps or machine paths', () => {
  const first = renderSarif(MIXED, CONTEXT);
  assert.equal(renderSarif({ ...MIXED, notices: [...MIXED.notices].reverse() }, CONTEXT), first);
  assert.equal(renderSarif(MIXED, CONTEXT), first);
  assert.ok(first.endsWith('}\n'));
  assert.equal(/\d{4}-\d{2}-\d{2}T/.test(first), false, 'no timestamp');
  assert.equal(first.includes(tmpdir()), false);
});

test('the format registry and dispatcher agree', () => {
  assert.deepEqual([...REPORT_FORMATS], ['markdown', 'json', 'sarif']);
  assert.equal(isReportFormat('json'), true);
  assert.equal(isReportFormat('xml'), false);
  assert.equal(isReportFormat('JSON'), false);
  assert.equal(renderReport('markdown', MIXED), renderMarkdown(MIXED), 'Markdown is untouched');
  assert.equal(renderReport('json', MIXED, CONTEXT), renderJson(MIXED, CONTEXT));
  assert.equal(renderReport('sarif', MIXED, CONTEXT), renderSarif(MIXED, CONTEXT));
  assert.doesNotThrow(() => renderReport('json', MIXED));
});

test('the formatters do not modify the comparison result', () => {
  const frozen = JSON.parse(JSON.stringify(MIXED));
  renderJson(MIXED, CONTEXT);
  renderSarif(MIXED, CONTEXT);
  assert.deepEqual(MIXED, frozen);
  assert.deepEqual(buildSarif(COMPATIBLE, CONTEXT).version, '2.1.0');
});

test('multi-file findings carry their logical locations into JSON and SARIF', () => {
  const root = `${HEADER}paths:\n  /users:\n    get:\n      responses:\n        '200':\n          description: ok\n          content:\n            application/json:\n              schema: { $ref: ./schemas/User.yaml }\n`;
  const user = fields => `type: object\nrequired: [id]\nproperties:\n${fields.map(f => `  ${f}: { type: string }`).join('\n')}\n`;
  const load = (fields) => {
    const directory = tree({ 'openapi.yaml': root, 'schemas/User.yaml': user(fields) });
    return loadSpecification(readFileSync(join(directory, 'openapi.yaml'), 'utf8'), {
      path: 'openapi.yaml', source: createDirectorySource(directory, 'the directory', 'the directory'),
    });
  };
  const result = compareSpecifications(load(['id', 'name']), load(['id']));
  assert.deepEqual(result.breaking.map(f => f.code), ['RESPONSE_FIELD_REMOVED']);
  const report = JSON.parse(renderJson(result, CONTEXT));
  assertReportValid(report);
  assert.equal(report.breaking[0].location, 'GET /users 200 response [application/json].name');
  const sarif = JSON.parse(renderSarif(result, CONTEXT));
  assertSarifValid(sarif);
  assert.equal(sarif.runs[0].results[0].locations[0].logicalLocations[0].fullyQualifiedName, report.breaking[0].location);
});

// --- the CLI ----------------------------------------------------------------------------------

const CLI = join(__dirname, '..', '.build', 'cli.js');

function cli(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function pair(beforeText = api(), afterText = api({ fields: ['id', 'name'], maximum: 50, pattern: '^b' })) {
  const before = tree({ 'openapi.yaml': beforeText });
  const after = tree({ 'openapi.yaml': afterText });
  return { before, after, args: ['--base', join(before, 'openapi.yaml'), '--head', join(after, 'openapi.yaml')] };
}

test('the CLI default output is still the Markdown report, unchanged', () => {
  const { args } = pair();
  const plain = cli(args);
  assert.equal(plain.status, 1);
  assert.equal(plain.stdout, `${renderMarkdown(REAL)}\n`);
  const explicit = cli([...args, '--format', 'markdown']);
  assert.deepEqual(explicit, plain);
});

test('--format json prints exactly one JSON document and nothing else', () => {
  const { args } = pair();
  const run = cli([...args, '--format', 'json']);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, '');
  assert.ok(run.stdout.startsWith('{\n') && run.stdout.endsWith('}\n'));
  const report = JSON.parse(run.stdout);
  assertReportValid(report);
  assert.equal(report.summary.status, 'breaking');
  assert.deepEqual(report.breaking.map(f => f.code).sort(), REAL.breaking.map(f => f.code).sort());
  assert.deepEqual(report.notices.map(f => f.code), REAL.notices.map(f => f.code));
  assert.equal(report.comparison.baseline.revision, null);
  assert.match(report.comparison.baseline.path, /openapi\.yaml$/);
});

test('--format sarif prints one schema-valid SARIF document and nothing else', () => {
  const { args } = pair();
  const run = cli([...args, '--format', 'sarif']);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, '');
  const log = JSON.parse(run.stdout);
  assertSarifValid(log);
  assert.equal(log.runs[0].results.length, REAL.breaking.length + REAL.notices.length);
  assert.equal(run.stdout.includes('physicalLocation'), false, 'the CLI knows no repository path to anchor to');
});

test('exit codes are unchanged in every format: 0 compatible, 1 breaking, 2 operational error', () => {
  const compatible = pair(api(), api({ fields: ['id', 'name', 'tag', 'extra'] }));
  const breaking = pair();
  for (const format of ['markdown', 'json', 'sarif']) {
    const ok = cli([...compatible.args, '--format', format]);
    assert.equal(ok.status, 0, `${format}: ${ok.stderr}`);
    assert.equal(cli([...breaking.args, '--format', format]).status, 1, format);
    const failed = cli(['--base', join(breaking.before, 'missing.yaml'), '--head', join(breaking.after, 'openapi.yaml'), '--format', format]);
    assert.equal(failed.status, 2, format);
    assert.equal(failed.stdout, '', `${format}: a failure leaves stdout empty`);
    assert.notEqual(failed.stderr, '');
  }
  const compat = JSON.parse(cli([...compatible.args, '--format', 'json']).stdout);
  assert.equal(compat.summary.status, 'compatible');
  assert.deepEqual(compat.breaking, []);
  assertSarifValid(JSON.parse(cli([...compatible.args, '--format', 'sarif']).stdout));
});

test('machine-readable output is byte-identical across runs', () => {
  const { args } = pair();
  for (const format of ['json', 'sarif']) {
    assert.equal(cli([...args, '--format', format]).stdout, cli([...args, '--format', format]).stdout);
  }
});

test('--output writes the selected format to a file, leaves stdout empty and keeps the exit code', () => {
  const { args, before } = pair();
  for (const format of ['markdown', 'json', 'sarif']) {
    const file = join(before, `out.${format}`);
    const piped = cli([...args, '--format', format]);
    const written = cli([...args, '--format', format, '--output', file]);
    assert.equal(written.status, piped.status, 'the file does not change the verdict');
    assert.equal(written.stdout, '', 'stdout stays empty');
    assert.equal(written.stderr, '');
    const expected = format === 'markdown' ? piped.stdout.slice(0, -1) : piped.stdout;
    assert.equal(readFileSync(file, 'utf8'), expected);
  }
  assertSarifValid(JSON.parse(readFileSync(join(before, 'out.sarif'), 'utf8')));
});

test('--output works relative to the working directory and overwrites an earlier report', () => {
  const { args, before } = pair();
  writeFileSync(join(before, 'report.json'), 'stale');
  const run = cli([...args, '--format', 'json', '--output', 'report.json'], before);
  assert.equal(run.status, 1);
  assertReportValid(JSON.parse(readFileSync(join(before, 'report.json'), 'utf8')));
});

test('the legacy --report flag still writes Markdown, whatever --format says', () => {
  const { args, before } = pair();
  const report = join(before, 'legacy.md');
  const run = cli([...args, '--format', 'json', '--report', report]);
  assert.equal(run.status, 1);
  assertReportValid(JSON.parse(run.stdout));
  assert.equal(readFileSync(report, 'utf8'), renderMarkdown(REAL));
  const both = cli([...args, '--format', 'sarif', '--output', join(before, 'o.sarif'), '--report', report]);
  assert.equal(both.status, 1);
  assertSarifValid(JSON.parse(readFileSync(join(before, 'o.sarif'), 'utf8')));
});

test('an unknown or missing --format fails with exit 2 before anything is printed', () => {
  const { args } = pair();
  for (const bad of [['--format', 'xml'], ['--format', 'JSON'], ['--format', ''], ['--format'], ['--format', '--output']]) {
    const run = cli([...args, ...bad]);
    assert.equal(run.status, 2, JSON.stringify(bad));
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /--format/);
    assert.match(run.stderr, /Usage:/);
  }
  assert.match(cli([...args, '--format', 'xml']).stderr, /Unsupported --format "xml"\. Use one of: markdown, json, sarif\./);
});

test('invalid --output paths fail with exit 2 and write nothing', () => {
  const { args, before, after } = pair();
  const missingDirectory = join(before, 'no', 'such', 'dir', 'out.json');
  const cases = [
    [['--output'], /--output needs a value/],
    [['--output', missingDirectory], /the directory .* does not exist/],
    [['--output', before], /is a directory/],
    [['--output', join(before, 'openapi.yaml')], /would be overwritten/],
    [['--output', join(after, 'openapi.yaml')], /would be overwritten/],
    [['--output', join(before, '.', 'openapi.yaml')], /would be overwritten/],
  ];
  const original = readFileSync(join(before, 'openapi.yaml'), 'utf8');
  for (const [extra, pattern] of cases) {
    const run = cli([...args, '--format', 'json', ...extra]);
    assert.equal(run.status, 2, JSON.stringify(extra));
    assert.equal(run.stdout, '');
    assert.match(run.stderr, pattern);
  }
  assert.equal(readFileSync(join(before, 'openapi.yaml'), 'utf8'), original, 'the specification was not touched');
  assert.equal(existsSync(join(before, 'no')), false);
});

test('an output file through a symlink to a compared specification is refused', () => {
  const { args, before } = pair();
  try {
    symlinkSync(join(before, 'openapi.yaml'), join(before, 'alias.json'));
  } catch {
    return; // no symlink privilege on this host
  }
  const run = cli([...args, '--output', join(before, 'alias.json')]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /would be overwritten/);
});

test('an operational error never prints a partial report, even with --output', () => {
  const { before, after } = pair();
  const out = join(before, 'out.json');
  const run = cli(['--base', join(before, 'gone.yaml'), '--head', join(after, 'openapi.yaml'), '--format', 'json', '--output', out]);
  assert.equal(run.status, 2);
  assert.equal(run.stdout, '');
  assert.equal(existsSync(out), false);
});

test('the CLI reports multi-file findings in JSON and SARIF', () => {
  const root = `${HEADER}paths:\n  /users:\n    get:\n      responses:\n        '200':\n          description: ok\n          content:\n            application/json:\n              schema: { $ref: ./schemas/User.yaml }\n`;
  const user = fields => `type: object\nrequired: [id]\nproperties:\n${fields.map(f => `  ${f}: { type: string }`).join('\n')}\n`;
  const before = tree({ 'openapi.yaml': root, 'schemas/User.yaml': user(['id', 'name']) });
  const after = tree({ 'openapi.yaml': root, 'schemas/User.yaml': user(['id']) });
  const args = ['--base', join(before, 'openapi.yaml'), '--head', join(after, 'openapi.yaml')];
  const report = JSON.parse(cli([...args, '--format', 'json']).stdout);
  assert.deepEqual(report.breaking.map(f => f.code), ['RESPONSE_FIELD_REMOVED']);
  const sarif = JSON.parse(cli([...args, '--format', 'sarif']).stdout);
  assertSarifValid(sarif);
  assert.equal(sarif.runs[0].results.length, 1);
  assert.equal(JSON.stringify(sarif).includes('physicalLocation'), false);
});

test('single-file CLI usage and exit codes are unchanged', () => {
  const examples = join(__dirname, '..', 'examples');
  const run = cli(['--base', join(examples, 'before.yaml'), '--head', join(examples, 'after.yaml')]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /ContractGuard API compatibility report/);
  assert.equal(cli([]).status, 2);
  assert.match(cli([]).stderr, /Usage:.*--format markdown\|json\|sarif.*--output/);
});

// --- the safe writer -----------------------------------------------------------------------------

function trySymlink(target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

test('writeRepositoryFile creates missing directories and overwrites a regular file', () => {
  const root = tree({ 'keep.txt': 'x' });
  writeRepositoryFile(root, 'reports/deep/out.json', 'first');
  assert.equal(readFileSync(join(root, 'reports/deep/out.json'), 'utf8'), 'first');
  writeRepositoryFile(root, 'reports/deep/out.json', 'second');
  assert.equal(readFileSync(join(root, 'reports/deep/out.json'), 'utf8'), 'second');
  assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'x');
});

test('writeRepositoryFile refuses symlinks, directories and non-plain paths, and writes nothing through them', () => {
  const root = tree({ 'victim.txt': 'precious', 'real/file.txt': 'real' });
  const outside = tree({ 'secret.txt': 'outside' });

  if (trySymlink(join(root, 'victim.txt'), join(root, 'link.json'))) {
    assert.throws(() => writeRepositoryFile(root, 'link.json', 'pwn'), /symbolic link/);
    assert.equal(readFileSync(join(root, 'victim.txt'), 'utf8'), 'precious');
  }
  if (trySymlink(outside, join(root, 'dirlink'), 'dir')) {
    assert.throws(() => writeRepositoryFile(root, 'dirlink/out.json', 'pwn'), /symbolic link/);
    assert.equal(existsSync(join(outside, 'out.json')), false);
  }
  if (trySymlink(join(outside, 'gone.txt'), join(root, 'dangling.json'))) {
    assert.throws(() => writeRepositoryFile(root, 'dangling.json', 'pwn'), /symbolic link/);
    assert.equal(existsSync(join(outside, 'gone.txt')), false, 'a dangling link is not created through');
  }
  assert.throws(() => writeRepositoryFile(root, 'real', 'x'), /not a regular file/);
  assert.throws(() => writeRepositoryFile(root, 'real/file.txt/under.json', 'x'), /not a directory/);
  assert.throws(() => writeRepositoryFile(root, '../escape.json', 'x'), /plain relative/);
  assert.throws(() => writeRepositoryFile(root, 'a/./b.json', 'x'), /plain relative/);
  assert.throws(() => writeRepositoryFile(root, '', 'x'), /plain relative/);
});

// --- the GitHub Action ------------------------------------------------------------------------------

function git(cwd, args) {
  const result = runGit(cwd, args);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function newRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'contractguard-report-git-'));
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

async function runAction({ directory, workspace = directory, specPath = 'openapi.yaml', baseSha, headSha, inputs = {} }) {
  const io = fakeIo();
  const outcome = await runContractGuard({
    inputs: { specPath, comment: false, githubToken: '', ...inputs },
    context: { eventName: 'pull_request', pullRequest: { number: 1, baseSha, headSha, isFork: false } },
    git: createGitAccess(workspace),
    files: createWorkspace(workspace),
    io: io.io,
    comments: null,
  });
  return { outcome, io };
}

/** A repository with a base commit and a feature commit; `change` edits the specification. */
function scenario(files, change) {
  const directory = newRepository();
  write(directory, files);
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  write(directory, change);
  const headSha = commit(directory, 'change');
  return { directory, baseSha, headSha };
}

const BREAKING_CHANGE = { 'openapi.yaml': api({ fields: ['id', 'name'], maximum: 50, pattern: '^b' }) };
const COMPATIBLE_CHANGE = { 'openapi.yaml': api({ fields: ['id', 'name', 'tag', 'extra'] }) };

function listFiles(directory) {
  return readdirSync(directory).filter(name => name !== '.git').sort();
}

test('the Action writes JSON and SARIF reports on request and keeps its verdict and outputs', needsGit, async () => {
  const { directory, baseSha, headSha } = scenario({ 'openapi.yaml': api() }, BREAKING_CHANGE);
  const { outcome, io } = await runAction({
    directory, baseSha, headSha,
    inputs: { jsonReportPath: 'reports/contractguard.json', sarifReportPath: 'reports/contractguard.sarif' },
  });
  assert.equal(outcome.status, 'breaking', outcome.error ?? '');
  assert.equal(io.record.outputs.breaking, 'true');
  assert.equal(io.record.outputs['json-report-path'], 'reports/contractguard.json');
  assert.equal(io.record.outputs['sarif-report-path'], 'reports/contractguard.sarif');
  assert.deepEqual(io.record.failed.length, 1, 'still fails the step exactly once, for the breaking change');
  assert.equal(io.record.summary.length, 1);

  const report = JSON.parse(readFileSync(join(directory, 'reports/contractguard.json'), 'utf8'));
  assertReportValid(report);
  assert.equal(report.summary.status, 'breaking');
  assert.equal(report.summary.breaking, outcome.breakingCount);
  assert.equal(report.summary.notices, outcome.noticeCount);
  assert.deepEqual(report.comparison.baseline, { path: 'openapi.yaml', revision: baseSha });
  assert.equal(report.comparison.head.path, 'openapi.yaml');
  assert.match(report.comparison.head.revision, /^[0-9a-f]{40}$/);

  const sarif = JSON.parse(readFileSync(join(directory, 'reports/contractguard.sarif'), 'utf8'));
  assertSarifValid(sarif);
  assert.equal(sarif.runs[0].results.length, outcome.breakingCount + outcome.noticeCount);
  assert.equal(sarif.runs[0].results[0].level, 'error');
  assert.ok(sarif.runs[0].results.every(r => r.locations[0].logicalLocations.length === 1));
});

test('for a single-file specification the SARIF results carry a file-level location and no region', needsGit, async () => {
  const { directory, baseSha, headSha } = scenario({ 'api/openapi.yaml': api() }, { 'api/openapi.yaml': BREAKING_CHANGE['openapi.yaml'] });
  const { outcome } = await runAction({
    directory, baseSha, headSha, specPath: 'api/openapi.yaml', inputs: { sarifReportPath: 'out.sarif' },
  });
  assert.equal(outcome.status, 'breaking');
  const text = readFileSync(join(directory, 'out.sarif'), 'utf8');
  const sarif = JSON.parse(text);
  assertSarifValid(sarif);
  for (const result of sarif.runs[0].results) {
    assert.deepEqual(result.locations[0].physicalLocation, { artifactLocation: { uri: 'api/openapi.yaml' } });
  }
  assert.equal(text.includes('"region"'), false);
});

test('for a multi-file specification the SARIF results stay logical-only, because the file is not known', needsGit, async () => {
  const root = `${HEADER}paths:\n  /users:\n    get:\n      responses:\n        '200':\n          description: ok\n          content:\n            application/json:\n              schema: { $ref: ./schemas/User.yaml }\n`;
  const user = fields => `type: object\nrequired: [id]\nproperties:\n${fields.map(f => `  ${f}: { type: string }`).join('\n')}\n`;
  const { directory, baseSha, headSha } = scenario(
    { 'openapi.yaml': root, 'schemas/User.yaml': user(['id', 'name']) },
    { 'schemas/User.yaml': user(['id']) },
  );
  const { outcome } = await runAction({
    directory, baseSha, headSha, inputs: { jsonReportPath: 'r.json', sarifReportPath: 'r.sarif' },
  });
  assert.equal(outcome.status, 'breaking', 'the root is unchanged; the change is in the referenced file');
  const text = readFileSync(join(directory, 'r.sarif'), 'utf8');
  assertSarifValid(JSON.parse(text));
  assert.equal(text.includes('physicalLocation'), false);
  const report = JSON.parse(readFileSync(join(directory, 'r.json'), 'utf8'));
  assertReportValid(report);
  assert.deepEqual(report.breaking.map(f => f.code), ['RESPONSE_FIELD_REMOVED']);
  assert.equal(report.comparison.baseline.revision, baseSha);
});

test('compatible and notice-only runs also produce valid reports', needsGit, async () => {
  const compatible = scenario({ 'openapi.yaml': api() }, COMPATIBLE_CHANGE);
  const first = await runAction({
    ...compatible, inputs: { jsonReportPath: 'c.json', sarifReportPath: 'c.sarif' },
  });
  assert.equal(first.outcome.status, 'compatible', first.outcome.error ?? '');
  assert.equal(JSON.parse(readFileSync(join(compatible.directory, 'c.json'), 'utf8')).summary.status, 'compatible');
  const log = JSON.parse(readFileSync(join(compatible.directory, 'c.sarif'), 'utf8'));
  assertSarifValid(log);
  assert.deepEqual(log.runs[0].results, []);

  const notice = scenario({ 'openapi.yaml': api() }, { 'openapi.yaml': api({ pattern: '^c' }) });
  const second = await runAction({ ...notice, inputs: { sarifReportPath: 'n.sarif' } });
  assert.equal(second.outcome.status, 'compatible');
  assert.ok(second.outcome.noticeCount >= 1);
  const noticeLog = JSON.parse(readFileSync(join(notice.directory, 'n.sarif'), 'utf8'));
  assertSarifValid(noticeLog);
  assert.ok(noticeLog.runs[0].results.every(r => r.level === 'warning'));
});

test('without the new inputs the Action writes no files and sets no new outputs', needsGit, async () => {
  const { directory, baseSha, headSha } = scenario({ 'openapi.yaml': api() }, BREAKING_CHANGE);
  const before = listFiles(directory);
  for (const inputs of [{}, { jsonReportPath: '', sarifReportPath: '   ' }, { jsonReportPath: undefined }]) {
    const { outcome, io } = await runAction({ directory, baseSha, headSha, inputs });
    assert.equal(outcome.status, 'breaking');
    assert.deepEqual(Object.keys(io.record.outputs).sort(), ['breaking', 'breaking-count', 'notice-count']);
  }
  assert.deepEqual(listFiles(directory), before);
});

test('the report files do not change the summary or the Markdown report', needsGit, async () => {
  const { directory, baseSha, headSha } = scenario({ 'openapi.yaml': api() }, BREAKING_CHANGE);
  const plain = await runAction({ directory, baseSha, headSha });
  const exporting = await runAction({ directory, baseSha, headSha, inputs: { jsonReportPath: 'o.json', sarifReportPath: 'o.sarif' } });
  assert.equal(exporting.outcome.report, plain.outcome.report);
  assert.deepEqual(exporting.io.record.summary, plain.io.record.summary);
  assert.equal(exporting.outcome.breakingCount, plain.outcome.breakingCount);
});

test('unsafe report paths fail the Action before anything is compared or written', needsGit, async () => {
  const { directory, baseSha, headSha } = scenario({ 'openapi.yaml': api() }, BREAKING_CHANGE);
  const outside = tree({});
  const cases = [
    ['/tmp/contractguard-abs.json', /absolute path/],
    ['C:\\temp\\out.json', /absolute path/],
    ['\\\\server\\share\\out.json', /absolute path/],
    ['../escape.json', /resolves outside it/],
    ['a/../../escape.json', /resolves outside it/],
    ['.git/hooks/pre-commit', /\.git/],
    ['x/.git/config', /\.git/],
    ['openapi.yaml', /overwrite it/],
    ['./openapi.yaml', /overwrite it/],
    ['reports/', /not a directory|must name a file/],
    ['out\0.json', /NUL/],
  ];
  for (const [value, pattern] of cases) {
    const { outcome, io } = await runAction({ directory, baseSha, headSha, inputs: { sarifReportPath: value } });
    assert.equal(outcome.status, 'failed', value);
    assert.match(outcome.error, pattern, value);
    assert.match(outcome.error, /sarif-report-path/);
    assert.equal(io.record.summary.length, 0, 'nothing was compared');
  }
  const json = await runAction({ directory, baseSha, headSha, inputs: { jsonReportPath: '../escape.json' } });
  assert.match(json.outcome.error, /json-report-path must point to a file inside the repository/);
  assert.equal(existsSync(join(directory, '..', 'escape.json')), false);
  assert.equal(existsSync(join(outside, 'escape.json')), false);
  assert.deepEqual(listFiles(directory), ['openapi.yaml']);
  const original = readFileSync(join(directory, 'openapi.yaml'), 'utf8');
  assert.equal(original, BREAKING_CHANGE['openapi.yaml']);

  const same = await runAction({ directory, baseSha, headSha, inputs: { jsonReportPath: 'x.out', sarifReportPath: './x.out' } });
  assert.match(same.outcome.error, /must be different files/);
});

test('a symbolic link planted at a report path cannot be used to write elsewhere', needsGit, async () => {
  const { directory, baseSha, headSha } = scenario({ 'openapi.yaml': api(), 'precious.txt': 'keep' }, BREAKING_CHANGE);
  const outside = tree({ 'target.txt': 'outside' });
  if (!trySymlink(join(outside, 'target.txt'), join(directory, 'link.sarif'))) return;
  if (!trySymlink(outside, join(directory, 'linked-dir'), 'dir')) return;

  const file = await runAction({ directory, baseSha, headSha, inputs: { sarifReportPath: 'link.sarif' } });
  assert.equal(file.outcome.status, 'failed');
  assert.match(file.outcome.error, /Could not write the SARIF report to "link\.sarif": .*symbolic link/);
  assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'outside');

  const parent = await runAction({ directory, baseSha, headSha, inputs: { jsonReportPath: 'linked-dir/out.json' } });
  assert.equal(parent.outcome.status, 'failed');
  assert.match(parent.outcome.error, /symbolic link/);
  assert.equal(existsSync(join(outside, 'out.json')), false);
  assert.equal(lstatSync(join(directory, 'link.sarif')).isSymbolicLink(), true, 'the link itself was left alone');
});

test('a report path that is an existing directory is refused', needsGit, async () => {
  const { directory, baseSha, headSha } = scenario({ 'openapi.yaml': api(), 'reports/keep.txt': 'x' }, BREAKING_CHANGE);
  const { outcome } = await runAction({ directory, baseSha, headSha, inputs: { jsonReportPath: 'reports' } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /not a regular file/);
  assert.equal(readFileSync(join(directory, 'reports/keep.txt'), 'utf8'), 'x');
});

test('the report paths resolve like spec-path when the workspace is a subdirectory of the repository', needsGit, async () => {
  const { directory, baseSha, headSha } = scenario(
    { 'services/users/openapi.yaml': api() },
    { 'services/users/openapi.yaml': BREAKING_CHANGE['openapi.yaml'] },
  );
  const workspace = join(directory, 'services', 'users');
  const { outcome } = await runAction({
    directory, workspace, specPath: 'openapi.yaml', baseSha, headSha, inputs: { jsonReportPath: 'out/report.json' },
  });
  assert.equal(outcome.status, 'breaking', outcome.error ?? '');
  const report = JSON.parse(readFileSync(join(workspace, 'out/report.json'), 'utf8'));
  assert.equal(report.comparison.head.path, 'services/users/openapi.yaml', 'the repository-relative path is reported');
});

test('the Action declares the new inputs and outputs, and keeps the old ones', () => {
  const manifest = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  for (const name of ['spec-path', 'comment', 'github-token', 'json-report-path', 'sarif-report-path']) {
    assert.match(manifest, new RegExp(`^  ${name}:`, 'm'), `input ${name}`);
  }
  for (const name of ['breaking', 'breaking-count', 'notice-count']) {
    assert.match(manifest, new RegExp(`^  ${name}:`, 'm'), `output ${name}`);
  }
  assert.match(manifest, /json-report-path:[\s\S]*?required: false/);
  assert.match(manifest, /sarif-report-path:[\s\S]*?required: false/);
  assert.doesNotMatch(manifest, /default:\s*['"]?\S+\.sarif/, 'no default path: nothing is written unless asked');
});
