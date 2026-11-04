const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runContractGuard, ACTIONS_BOT_LOGIN } = require('../.build/integration.js');
const { REPORT_MARKER } = require('../.build/report.js');

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const MERGE_BASE_SHA = 'c'.repeat(40);
const ROOT = '/work';
const SPEC = 'openapi.yaml';

function spec({ responseProperties, pattern = '^[a-z]+$', version = '3.0.3' } = {}) {
  const properties = responseProperties ?? { id: 'string', name: 'string' };
  const lines = Object.entries(properties).map(([name, type]) => {
    const extra = name === 'name' ? `, pattern: '${pattern}'` : '';
    return `                  ${name}: { type: ${type}${extra} }`;
  });
  return [
    `openapi: ${version}`,
    'info: { title: Users, version: 1.0.0 }',
    'paths:',
    '  /users:',
    '    get:',
    '      responses:',
    "        '200':",
    '          description: ok',
    '          content:',
    '            application/json:',
    '              schema:',
    '                type: object',
    '                required: [id]',
    '                properties:',
    ...lines,
    '',
  ].join('\n');
}

const BASE_SPEC = spec();
const UNCHANGED_SPEC = spec();
const COMPATIBLE_SPEC = spec({ responseProperties: { id: 'string', name: 'string', createdAt: 'string' } });
const BREAKING_SPEC = spec({ responseProperties: { id: 'string' } });
const NOTICE_ONLY_SPEC = spec({ pattern: '^[a-z]{2,}$' });
const BREAKING_AND_NOTICE_SPEC = spec({ responseProperties: { id: 'integer', name: 'string' }, pattern: '^[A-Z]+$' });
const INVALID_SPEC = 'swagger: "2.0"\npaths: {}\n';

/** An in-memory Git tree: `{ sha: { path: contents } }`. */
function fakeGit(options = {}) {
  const {
    root = ROOT,
    commits = { [BASE_SHA]: { [SPEC]: BASE_SPEC }, [HEAD_SHA]: {} },
    mergeBase,
    readFailure = null,
    head = HEAD_SHA,
  } = options;
  const calls = { fileExistsAt: [], readFileAt: [], mergeBase: [], commitExists: [], resolveCommit: [] };
  return {
    calls,
    access: {
      repositoryRoot: () => root,
      resolveCommit(revision) {
        calls.resolveCommit.push(revision);
        if (revision === 'HEAD') return head;
        return Object.prototype.hasOwnProperty.call(commits, revision) ? revision : null;
      },
      commitExists(sha) {
        calls.commitExists.push(sha);
        return Object.prototype.hasOwnProperty.call(commits, sha);
      },
      mergeBase(left, right) {
        calls.mergeBase.push([left, right]);
        if (typeof mergeBase === 'function') return mergeBase(left, right);
        if (mergeBase === undefined) return left;
        return mergeBase;
      },
      fileExistsAt(sha, path) {
        calls.fileExistsAt.push([sha, path]);
        return Boolean(commits[sha]) && Object.prototype.hasOwnProperty.call(commits[sha], path);
      },
      readFileAt(sha, path) {
        calls.readFileAt.push([sha, path]);
        if (readFailure) throw new Error(readFailure);
        if (!commits[sha] || !(path in commits[sha])) throw new Error(`fatal: path '${path}' does not exist in '${sha}'`);
        return commits[sha][path];
      },
    },
  };
}

function fakeFiles(options = {}) {
  const { root = ROOT, files = { [`${ROOT}/${SPEC}`]: UNCHANGED_SPEC }, readFailure = null } = options;
  return {
    isAbsolute: path => path.startsWith('/'),
    resolve: path => (path.startsWith('/') ? path : `${root}/${path}`),
    relativeTo(base, absolute) {
      const prefix = `${base}/`;
      if (!absolute.startsWith(prefix)) return null;
      const relative = absolute.slice(prefix.length);
      if (relative === '' || relative === '..' || relative.startsWith('../')) return null;
      return relative;
    },
    exists: absolute => Object.prototype.hasOwnProperty.call(files, absolute),
    read(absolute) {
      if (readFailure) throw new Error(readFailure);
      if (!(absolute in files)) throw new Error(`ENOENT: no such file '${absolute}'`);
      return files[absolute];
    },
  };
}

function fakeIo(options = {}) {
  const record = { info: [], warning: [], outputs: {}, failed: [], summary: [] };
  return {
    record,
    io: {
      info: message => record.info.push(message),
      warning: message => record.warning.push(message),
      setOutput: (name, value) => { record.outputs[name] = value; },
      setFailed: message => record.failed.push(message),
      writeSummary: async markdown => {
        if (options.summaryFailure) throw new Error(options.summaryFailure);
        record.summary.push(markdown);
      },
    },
  };
}

function fakeComments(options = {}) {
  const existing = (options.existing ? [...options.existing] : []).map(comment => ({
    author: ACTIONS_BOT_LOGIN,
    ...comment,
  }));
  const record = { listed: 0, created: [], updated: [], identityCalls: 0 };
  return {
    record,
    api: {
      async identity() {
        record.identityCalls += 1;
        if (options.identityFailure) throw new Error(options.identityFailure);
        return options.identity ?? { login: ACTIONS_BOT_LOGIN, verified: false };
      },
      async list() {
        record.listed += 1;
        if (options.listFailure) throw new Error(options.listFailure);
        return existing;
      },
      async update(id, body) {
        if (options.writeFailure) throw new Error(options.writeFailure);
        record.updated.push({ id, body });
      },
      async create(body) {
        if (options.writeFailure) throw new Error(options.writeFailure);
        record.created.push(body);
      },
    },
  };
}

/** Builds a complete environment, overriding only what a test cares about. */
function environment(options = {}) {
  const git = fakeGit(options.git);
  const io = fakeIo(options.io);
  const comments = options.comments === null ? null : fakeComments(options.comments);
  const files = fakeFiles(options.files);
  const env = {
    inputs: {
      specPath: SPEC,
      comment: false,
      githubToken: '',
      ...options.inputs,
    },
    context: {
      eventName: 'pull_request',
      pullRequest: {
        number: 7,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        isFork: false,
        ...options.pullRequest,
      },
      ...options.context,
    },
    git: git.access,
    files,
    io: io.io,
    comments: comments ? comments.api : null,
  };
  return { env, git, io, comments };
}

const run = async options => {
  const built = environment(options);
  const outcome = await runContractGuard(built.env);
  return { outcome, ...built };
};

// --- 1..3: the three ordinary outcomes --------------------------------------

test('a compatible change passes the check', async () => {
  const { outcome, io } = await run({
    files: { files: { [`${ROOT}/${SPEC}`]: COMPATIBLE_SPEC } },
  });
  assert.equal(outcome.status, 'compatible');
  assert.equal(outcome.breakingCount, 0);
  assert.deepEqual(io.record.failed, []);
  assert.equal(io.record.outputs.breaking, 'false');
  assert.equal(io.record.outputs['breaking-count'], '0');
  assert.equal(io.record.summary.length, 1);
  assert.match(io.record.summary[0], /No breaking changes detected/);
});

test('a breaking change fails the check', async () => {
  const { outcome, io } = await run({
    files: { files: { [`${ROOT}/${SPEC}`]: BREAKING_SPEC } },
  });
  assert.equal(outcome.status, 'breaking');
  assert.equal(outcome.breakingCount, 1);
  assert.equal(io.record.failed.length, 1);
  assert.match(io.record.failed[0], /detected 1 potentially breaking API change\./);
  assert.equal(io.record.outputs.breaking, 'true');
  assert.equal(io.record.outputs['breaking-count'], '1');
  assert.match(io.record.summary[0], /RESPONSE_FIELD_REMOVED/);
});

test('an unchanged specification passes the check', async () => {
  const { outcome, io } = await run();
  assert.equal(outcome.status, 'compatible');
  assert.equal(outcome.breakingCount, 0);
  assert.equal(outcome.noticeCount, 0);
  assert.deepEqual(io.record.failed, []);
  assert.deepEqual(io.record.warning, []);
});

// --- 4..5: review notices ----------------------------------------------------

test('a breaking change with review notices reports both and fails', async () => {
  const { outcome, io } = await run({
    files: { files: { [`${ROOT}/${SPEC}`]: BREAKING_AND_NOTICE_SPEC } },
  });
  assert.equal(outcome.status, 'breaking');
  assert.ok(outcome.breakingCount > 0, 'breaking changes are reported');
  assert.ok(outcome.noticeCount > 0, 'notices are reported alongside them');
  assert.equal(io.record.failed.length, 1);
  assert.match(io.record.summary[0], /SCHEMA_TYPE_CHANGED/);
  assert.match(io.record.summary[0], /CONSTRAINT_NOT_COMPARED/);
  assert.ok(io.record.warning.some(w => /could not be evaluated/.test(w)));
});

test('review notices alone pass the check but raise a visible warning', async () => {
  const { outcome, io } = await run({
    files: { files: { [`${ROOT}/${SPEC}`]: NOTICE_ONLY_SPEC } },
  });
  assert.equal(outcome.status, 'compatible');
  assert.equal(outcome.breakingCount, 0);
  assert.equal(outcome.noticeCount, 1);
  assert.deepEqual(io.record.failed, []);
  assert.equal(io.record.outputs['notice-count'], '1');
  assert.ok(io.record.warning.some(w => /manual review/.test(w)),
    'a passing check still says a review is needed');
  assert.match(io.record.summary[0], /CONSTRAINT_NOT_COMPARED/);
});

// --- 6..9: failures must never read as compatible ---------------------------

test('a baseline specification missing at the base commit is a clear error', async () => {
  const { outcome, io } = await run({
    git: { commits: { [BASE_SHA]: {}, [HEAD_SHA]: {} } },
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.breakingCount, 0);
  assert.match(outcome.error, /does not exist at the/);
  assert.match(outcome.error, /will not report that as compatible/);
  assert.equal(io.record.failed.length, 1);
  assert.deepEqual(io.record.summary, [], 'no summary claims a result');
});

test('a head specification missing from the checkout is a clear error', async () => {
  const { outcome, io } = await run({ files: { files: {} } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /is missing from the checkout/);
  assert.match(outcome.error, /will not report a missing specification as compatible/);
  assert.equal(io.record.failed.length, 1);
});

test('an unreadable head specification is a clear error', async () => {
  const { outcome } = await run({ files: { readFailure: 'EACCES: permission denied' } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Could not read "openapi\.yaml" from the checkout/);
  assert.match(outcome.error, /EACCES/);
});

test('a failing git read is reported, not treated as compatible', async () => {
  const { outcome } = await run({ git: { readFailure: 'fatal: unable to read object' } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Could not read "openapi\.yaml" at the/);
  assert.match(outcome.error, /unable to read object/);
});

test('an invalid baseline document is a clear error naming where it came from', async () => {
  const { outcome } = await run({
    git: { commits: { [BASE_SHA]: { [SPEC]: INVALID_SPEC }, [HEAD_SHA]: {} } },
  });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /from the base commit/);
  assert.match(outcome.error, /OpenAPI 3\.0 and 3\.1/);
});

test('an invalid head document is a clear error naming the pull request', async () => {
  const { outcome } = await run({ files: { files: { [`${ROOT}/${SPEC}`]: INVALID_SPEC } } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /from this pull request could not be read/);
});

test('a base commit outside a shallow clone explains fetch-depth', async () => {
  const { outcome } = await run({ git: { commits: { [HEAD_SHA]: {} } } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /is not in the local clone/);
  assert.match(outcome.error, /fetch-depth: 0/);
});

test('a workspace without a repository explains that checkout is required', async () => {
  const { outcome } = await run({ git: { root: null } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /No Git repository was found/);
  assert.match(outcome.error, /actions\/checkout/);
});

test('an unusable base SHA in the payload is reported', async () => {
  const { outcome } = await run({ pullRequest: { baseSha: 'not-a-sha' } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /did not provide a usable base commit SHA/);
});

// --- event safety ------------------------------------------------------------

test('pull_request_target is refused with an explanation', async () => {
  const { outcome, io } = await run({ context: { eventName: 'pull_request_target' } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /does not run on pull_request_target/);
  assert.match(outcome.error, /would silently pass/);
  assert.equal(io.record.failed.length, 1);
});

test('a non pull request event is refused and points at the CLI', async () => {
  const { outcome } = await run({ context: { eventName: 'push', pullRequest: null } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /runs on pull_request events only, but the event was "push"/);
  assert.match(outcome.error, /Use the CLI/);
});

// --- baseline selection ------------------------------------------------------

test('the merge base is preferred over the base branch tip', async () => {
  const { outcome, io } = await run({
    git: {
      commits: {
        [BASE_SHA]: {},
        [HEAD_SHA]: {},
        [MERGE_BASE_SHA]: { [SPEC]: BASE_SPEC },
      },
      mergeBase: () => MERGE_BASE_SHA,
    },
  });
  assert.equal(outcome.status, 'compatible');
  assert.equal(outcome.baselineSha, MERGE_BASE_SHA);
  assert.ok(io.record.info.some(m => /against the merge base/.test(m)),
    'the chosen baseline is logged');
});

test('the baseline is always the common ancestor of the base and the checked-out HEAD', async () => {
  const { git } = await run({ git: { mergeBase: () => BASE_SHA } });
  assert.deepEqual(git.calls.mergeBase, [[BASE_SHA, 'HEAD']],
    'the payload head SHA is never used to pick the baseline');
});

test('the log names the checked-out commit as the pull request head when they match', async () => {
  const { io } = await run({ git: { head: HEAD_SHA }, pullRequest: { headSha: HEAD_SHA } });
  assert.ok(io.record.info.some(m => /Comparing the pull request head/.test(m)));
});

test('the log names a merge commit when HEAD is not the pull request head', async () => {
  const { io } = await run({ git: { head: 'f'.repeat(40) } });
  assert.ok(io.record.info.some(m => /Comparing a merge of the pull request into the base branch/.test(m)));
});

test('a missing common ancestor fails with actionable guidance instead of guessing', async () => {
  const { outcome, io } = await run({ git: { mergeBase: () => null } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Could not find a common ancestor/);
  assert.match(outcome.error, /fetch-depth: 0/);
  assert.match(outcome.error, /will not fall back to a different baseline/);
  assert.equal(io.record.failed.length, 1);
  assert.deepEqual(io.record.summary, [], 'no result is reported when the baseline is unknown');
});

test('a merge base that is not present locally is a failure, not a fallback', async () => {
  const { outcome } = await run({ git: { mergeBase: () => 'e'.repeat(40) } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Could not find a common ancestor/);
});

test('an unresolvable HEAD is reported', async () => {
  const { outcome } = await run({ git: { head: null } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Could not resolve HEAD/);
});

// --- 12 plus path safety -----------------------------------------------------

test('a path containing spaces and shell characters is passed through unchanged', async () => {
  const awkward = 'specs/my api (v2) $(whoami) & more.yaml';
  const { outcome, git } = await run({
    inputs: { specPath: awkward },
    git: { commits: { [BASE_SHA]: { [awkward]: BASE_SPEC }, [HEAD_SHA]: {} } },
    files: { files: { [`${ROOT}/${awkward}`]: UNCHANGED_SPEC } },
  });
  assert.equal(outcome.status, 'compatible');
  assert.deepEqual(git.calls.readFileAt, [[BASE_SHA, awkward]],
    'the path reaches git as a single argument, verbatim');
});

test('an absolute spec-path is rejected', async () => {
  const { outcome } = await run({ inputs: { specPath: '/etc/passwd' } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /must be relative to the repository/);
});

test('a spec-path escaping the repository is rejected', async () => {
  const { outcome } = await run({ inputs: { specPath: '../outside.yaml' } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /resolves outside it/);
});

test('an empty or NUL-bearing spec-path is rejected', async () => {
  const empty = await run({ inputs: { specPath: '   ' } });
  assert.match(empty.outcome.error, /must not be empty/);
  const nul = await run({ inputs: { specPath: 'spec\u0000.yaml' } });
  assert.match(nul.outcome.error, /must not contain NUL/);
});

test('a JSON specification is compared like a YAML one', async () => {
  const jsonSpec = JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Users', version: '1.0.0' },
    paths: { '/users': { get: { responses: { 200: { description: 'ok', content: { 'application/json': {
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    } } } } } } },
  });
  const breakingJson = jsonSpec.replace('"type":"string"', '"type":"integer"');
  const { outcome } = await run({
    inputs: { specPath: 'openapi.json' },
    git: { commits: { [BASE_SHA]: { 'openapi.json': jsonSpec }, [HEAD_SHA]: {} } },
    files: { files: { [`${ROOT}/openapi.json`]: breakingJson } },
  });
  assert.equal(outcome.status, 'breaking');
  assert.equal(outcome.breakingCount, 1);
});

// --- 10..11: optional commenting --------------------------------------------

test('commenting is off by default and no API call is made', async () => {
  const { outcome, comments } = await run();
  assert.equal(outcome.comment, 'disabled');
  assert.equal(comments.record.listed, 0);
});

test('a missing token with comment enabled warns and still reports the result', async () => {
  const { outcome, io, comments } = await run({
    inputs: { comment: true, githubToken: '' },
    comments: null,
    files: { files: { [`${ROOT}/${SPEC}`]: BREAKING_SPEC } },
  });
  assert.equal(outcome.comment, 'skipped');
  assert.equal(outcome.status, 'breaking', 'the compatibility result is unaffected');
  assert.equal(io.record.failed.length, 1);
  assert.ok(io.record.warning.some(w => /needs a github-token/.test(w)));
  assert.equal(comments, null);
});

test('a first run creates the comment', async () => {
  const { outcome, comments } = await run({
    inputs: { comment: true, githubToken: 'token' },
    comments: { existing: [{ id: 1, body: 'unrelated discussion' }] },
  });
  assert.equal(outcome.comment, 'created');
  assert.equal(comments.record.created.length, 1);
  assert.match(comments.record.created[0], new RegExp(REPORT_MARKER.replace(/[-[\]{}()*+?.\\^$|]/g, '\\$&')));
  assert.deepEqual(comments.record.updated, []);
});

test('a later run updates the existing report instead of posting a duplicate', async () => {
  const { outcome, comments } = await run({
    inputs: { comment: true, githubToken: 'token' },
    comments: { existing: [{ id: 11, body: `${REPORT_MARKER}\nan older report` }] },
  });
  assert.equal(outcome.comment, 'updated');
  assert.deepEqual(comments.record.created, []);
  assert.equal(comments.record.updated.length, 1);
  assert.equal(comments.record.updated[0].id, 11);
});

// --- comment ownership ------------------------------------------------------
// The marker alone is not proof of ownership: anyone who can comment on the pull
// request can paste it. A comment is only edited when the marker and the author
// both match the account the token acts as.

test('a report written by the Actions bot is updated', async () => {
  const { outcome, comments } = await run({
    inputs: { comment: true, githubToken: 'token' },
    comments: {
      identity: { login: ACTIONS_BOT_LOGIN, verified: false },
      existing: [{ id: 5, body: `${REPORT_MARKER} earlier run`, author: ACTIONS_BOT_LOGIN }],
    },
  });
  assert.equal(outcome.comment, 'updated');
  assert.equal(comments.record.updated[0].id, 5);
  assert.deepEqual(comments.record.created, []);
  assert.ok(comments.record.identityCalls > 0, 'ownership is checked before editing');
});

test('a report written through a personal access token is updated', async () => {
  const { outcome, comments } = await run({
    inputs: { comment: true, githubToken: 'pat' },
    comments: {
      identity: { login: 'octocat', verified: true },
      existing: [
        { id: 4, body: 'drive-by review comment', author: 'reviewer' },
        { id: 5, body: `${REPORT_MARKER} earlier run from a PAT`, author: 'octocat' },
      ],
    },
  });
  assert.equal(outcome.comment, 'updated');
  assert.equal(comments.record.updated[0].id, 5);
  assert.deepEqual(comments.record.created, []);
});

test('logins are matched without regard to case', async () => {
  const { outcome, comments } = await run({
    inputs: { comment: true, githubToken: 'pat' },
    comments: {
      identity: { login: 'OctoCat', verified: true },
      existing: [{ id: 6, body: `${REPORT_MARKER} earlier run`, author: 'octocat' }],
    },
  });
  assert.equal(outcome.comment, 'updated');
  assert.equal(comments.record.updated[0].id, 6);
});

test("another participant's copied marker is never edited", async () => {
  const { outcome, comments, io } = await run({
    inputs: { comment: true, githubToken: 'token' },
    comments: {
      identity: { login: ACTIONS_BOT_LOGIN, verified: false },
      existing: [{ id: 9, body: `${REPORT_MARKER}\nlooks official, is not`, author: 'passer-by' }],
    },
  });
  assert.equal(outcome.comment, 'created');
  assert.deepEqual(comments.record.updated, [], "a comment this token does not own is left alone");
  assert.equal(comments.record.created.length, 1);
  const warning = io.record.warning.find(w => /carry the ContractGuard marker/.test(w));
  assert.ok(warning, 'the ignored comment is reported');
  assert.match(warning, /passer-by/);
  assert.match(warning, /only edits its own comments/);
});

test('a copied marker alongside the real report updates only the real one', async () => {
  const { outcome, comments } = await run({
    inputs: { comment: true, githubToken: 'token' },
    comments: {
      identity: { login: ACTIONS_BOT_LOGIN, verified: false },
      existing: [
        { id: 9, body: `${REPORT_MARKER} impostor`, author: 'passer-by' },
        { id: 10, body: `${REPORT_MARKER} the real one`, author: ACTIONS_BOT_LOGIN },
      ],
    },
  });
  assert.equal(outcome.comment, 'updated');
  assert.equal(comments.record.updated.length, 1);
  assert.equal(comments.record.updated[0].id, 10);
});

test('an unverifiable identity falls back to posting a new comment', async () => {
  const { outcome, comments, io } = await run({
    inputs: { comment: true, githubToken: 'token' },
    comments: {
      identityFailure: 'HttpError: 500 Internal Server Error',
      existing: [{ id: 11, body: `${REPORT_MARKER} earlier run`, author: ACTIONS_BOT_LOGIN }],
    },
  });
  assert.equal(outcome.comment, 'created');
  assert.deepEqual(comments.record.updated, [], 'nothing is edited without established ownership');
  assert.ok(io.record.warning.some(w => /Could not establish which account the token posts as/.test(w)));
});

test('a comment with no author is never treated as owned', async () => {
  const { outcome, comments } = await run({
    inputs: { comment: true, githubToken: 'token' },
    comments: {
      identity: { login: ACTIONS_BOT_LOGIN, verified: false },
      existing: [{ id: 12, body: `${REPORT_MARKER} ghost`, author: null }],
    },
  });
  assert.equal(outcome.comment, 'created');
  assert.deepEqual(comments.record.updated, []);
});

test('an assumed identity is explained rather than silently trusted', async () => {
  const { io } = await run({
    inputs: { comment: true, githubToken: 'token' },
    comments: { identity: { login: ACTIONS_BOT_LOGIN, verified: false } },
  });
  assert.ok(io.record.info.some(m => /could not be read from the API/.test(m)
    && m.includes(ACTIONS_BOT_LOGIN)));
});

test('a verified identity produces no assumption note', async () => {
  const { io } = await run({
    inputs: { comment: true, githubToken: 'pat' },
    comments: { identity: { login: 'octocat', verified: true } },
  });
  assert.ok(!io.record.info.some(m => /could not be read from the API/.test(m)));
});

test('a comment with a null body does not break the search', async () => {
  const { outcome, comments } = await run({
    inputs: { comment: true, githubToken: 'token' },
    comments: { existing: [{ id: 3, body: null }] },
  });
  assert.equal(outcome.comment, 'created');
  assert.equal(comments.record.created.length, 1);
});

test('a read-only token on a fork PR warns and never hides a breaking result', async () => {
  const { outcome, io } = await run({
    inputs: { comment: true, githubToken: 'token' },
    pullRequest: { isFork: true },
    comments: { writeFailure: 'HttpError: Resource not accessible by integration' },
    files: { files: { [`${ROOT}/${SPEC}`]: BREAKING_SPEC } },
  });
  assert.equal(outcome.comment, 'failed');
  assert.equal(outcome.status, 'breaking');
  assert.equal(outcome.breakingCount, 1);
  assert.equal(io.record.failed.length, 1, 'the check still fails');
  const warning = io.record.warning.find(w => /Could not post the pull request comment/.test(w));
  assert.ok(warning, 'the comment failure is surfaced as a warning');
  assert.match(warning, /expected for pull requests from forks/);
  assert.match(warning, /compatibility result is unaffected/);
});

test('a GitHub API failure while listing comments does not change the result', async () => {
  const { outcome, io } = await run({
    inputs: { comment: true, githubToken: 'token' },
    comments: { listFailure: 'HttpError: 502 Bad Gateway' },
    files: { files: { [`${ROOT}/${SPEC}`]: COMPATIBLE_SPEC } },
  });
  assert.equal(outcome.comment, 'failed');
  assert.equal(outcome.status, 'compatible');
  assert.deepEqual(io.record.failed, []);
  assert.ok(io.record.warning.some(w => /502 Bad Gateway/.test(w)));
});

// --- job summary -------------------------------------------------------------

test('a failing job summary is a warning, not a lost result', async () => {
  const { outcome, io } = await run({
    io: { summaryFailure: 'ENOENT: GITHUB_STEP_SUMMARY is not set' },
    files: { files: { [`${ROOT}/${SPEC}`]: BREAKING_SPEC } },
  });
  assert.equal(outcome.status, 'breaking');
  assert.equal(io.record.failed.length, 1);
  assert.ok(io.record.warning.some(w => /Could not write the job summary/.test(w)));
});

test('every documented output is set on a successful run', async () => {
  const { io } = await run({ files: { files: { [`${ROOT}/${SPEC}`]: NOTICE_ONLY_SPEC } } });
  assert.deepEqual(Object.keys(io.record.outputs).sort(), ['breaking', 'breaking-count', 'notice-count']);
});
