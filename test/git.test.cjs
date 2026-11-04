const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { createGitAccess, runGit } = require('../.build/git.js');
const { createWorkspace } = require('../.build/workspace.js');
const { runContractGuard } = require('../.build/integration.js');

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const needsGit = { skip: gitAvailable ? false : 'git is not available on PATH' };

const BASE_SPEC = `openapi: 3.0.3
info: { title: Users, version: 1.0.0 }
paths:
  /users:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [id]
                properties:
                  id: { type: string }
                  name: { type: string }
`;

const BREAKING_SPEC = BASE_SPEC.replace('                  name: { type: string }\n', '');
const COMPATIBLE_SPEC = `${BASE_SPEC}                  createdAt: { type: string }\n`;

/** Two independent paths, so two branches can edit far-apart regions. */
const TWO_PATH_SPEC = `openapi: 3.0.3
info: { title: Users, version: 1.0.0 }
paths:
  /users:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [id]
                properties:
                  id: { type: string }
                  name: { type: string }
  /orders:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [total]
                properties:
                  total: { type: integer }
                  currency: { type: string }
`;

/** The base branch drops a response field: breaking, but not this PR's doing. */
const TWO_PATH_BASE_BREAKING = TWO_PATH_SPEC.replace('                  currency: { type: string }\n', '');
/** The feature branch adds an optional field: compatible. */
const TWO_PATH_FEATURE = TWO_PATH_SPEC.replace(
  '                  name: { type: string }\n',
  '                  name: { type: string }\n                  nickname: { type: string }\n',
);

const repositories = [];

function git(cwd, args) {
  const result = runGit(cwd, args);
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A throwaway repository with its own identity, independent of global config. */
function newRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'contractguard-git-'));
  repositories.push(directory);
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

function writeSpec(directory, relativePath, contents) {
  const target = join(directory, relativePath);
  const parent = target.slice(0, Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')));
  if (parent && parent !== directory) mkdirSync(parent, { recursive: true });
  writeFileSync(target, contents);
}

process.on('exit', () => {
  for (const directory of repositories) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A leftover temporary directory must never fail the test run.
    }
  }
});

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

async function runInRepository(options) {
  const { directory, workspace = options.directory, specPath, baseSha, headSha } = options;
  const io = fakeIo();
  const outcome = await runContractGuard({
    inputs: { specPath, comment: false, githubToken: '' },
    context: {
      eventName: 'pull_request',
      pullRequest: { number: 1, baseSha, headSha, isFork: false },
    },
    git: createGitAccess(workspace),
    files: createWorkspace(workspace),
    io: io.io,
    comments: null,
  });
  return { outcome, io, directory };
}

// --- the Git adapter ---------------------------------------------------------

test('the git adapter reads the repository root and commit reachability', needsGit, () => {
  const directory = newRepository();
  writeSpec(directory, 'openapi.yaml', BASE_SPEC);
  const sha = commit(directory, 'add specification');
  const access = createGitAccess(directory);

  assert.ok(access.repositoryRoot(), 'the working tree root is reported');
  assert.equal(access.commitExists(sha), true);
  assert.equal(access.commitExists('0'.repeat(40)), false, 'an absent commit is not invented');
  assert.equal(access.fileExistsAt(sha, 'openapi.yaml'), true);
  assert.equal(access.fileExistsAt(sha, 'missing.yaml'), false);
  assert.equal(access.readFileAt(sha, 'openapi.yaml'), BASE_SPEC);
});

test('the git adapter reports no repository outside a working tree', needsGit, () => {
  const directory = mkdtempSync(join(tmpdir(), 'contractguard-bare-'));
  repositories.push(directory);
  const root = createGitAccess(directory).repositoryRoot();
  // A temporary directory may sit inside an unrelated repository on some hosts;
  // what matters is that this directory is not reported as its own root.
  assert.notEqual(root, directory);
});

test('the git adapter surfaces a git error when reading a missing path', needsGit, () => {
  const directory = newRepository();
  writeSpec(directory, 'openapi.yaml', BASE_SPEC);
  const sha = commit(directory, 'add specification');
  assert.throws(() => createGitAccess(directory).readFileAt(sha, 'nope.yaml'), /does not exist|exited with status/);
});

test('the git adapter finds the merge base of two branches', needsGit, () => {
  const directory = newRepository();
  writeSpec(directory, 'openapi.yaml', BASE_SPEC);
  const forkPoint = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  writeSpec(directory, 'openapi.yaml', COMPATIBLE_SPEC);
  const headSha = commit(directory, 'feature change');
  git(directory, ['checkout', '--quiet', 'main']);
  writeSpec(directory, 'unrelated.txt', 'moved on\n');
  const baseTip = commit(directory, 'base branch moves on');

  const access = createGitAccess(directory);
  assert.equal(access.mergeBase(baseTip, headSha), forkPoint);
  assert.equal(access.mergeBase('0'.repeat(40), headSha), null, 'an impossible merge base is null, not a throw');
});

// --- no shell is involved ----------------------------------------------------

test('a path with shell metacharacters is read literally and executes nothing', needsGit, () => {
  const directory = newRepository();
  const hostile = 'my api $(touch pwned) & echo hi.yaml';
  writeSpec(directory, hostile, BASE_SPEC);
  const sha = commit(directory, 'add awkward path');
  const access = createGitAccess(directory);

  assert.equal(access.fileExistsAt(sha, hostile), true, 'the path is matched verbatim');
  assert.equal(access.readFileAt(sha, hostile), BASE_SPEC);
  assert.equal(existsSync(join(directory, 'pwned')), false, 'no command substitution happened');
  assert.equal(existsSync(join(process.cwd(), 'pwned')), false);
});

// --- the workspace adapter ---------------------------------------------------

test('the workspace adapter keeps paths inside the repository', () => {
  const files = createWorkspace('/work');
  assert.equal(files.relativeTo('/work', '/work/openapi.yaml'), 'openapi.yaml');
  assert.equal(files.relativeTo('/work', '/work/specs/api.yaml'), 'specs/api.yaml');
  assert.equal(files.relativeTo('/work', '/work'), null, 'the root itself is not a file');
  assert.equal(files.relativeTo('/work', '/etc/passwd'), null);
  assert.equal(files.relativeTo('/work', '/workother/api.yaml'), null, 'a sibling prefix is not inside');
  assert.equal(files.isAbsolute('openapi.yaml'), false);
});

test('the workspace adapter reports a real file and reads it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'contractguard-ws-'));
  repositories.push(directory);
  writeFileSync(join(directory, 'openapi.yaml'), BASE_SPEC);
  const files = createWorkspace(directory);
  const absolute = files.resolve('openapi.yaml');
  assert.equal(files.exists(absolute), true);
  assert.equal(files.read(absolute), BASE_SPEC);
  assert.equal(files.exists(files.resolve('missing.yaml')), false);
  assert.equal(files.exists(directory), false, 'a directory is not a specification file');
});

// --- end to end against a real repository -----------------------------------

test('a breaking change in a real repository fails the check', needsGit, async () => {
  const directory = newRepository();
  writeSpec(directory, 'openapi.yaml', BASE_SPEC);
  const baseSha = commit(directory, 'base');
  writeSpec(directory, 'openapi.yaml', BREAKING_SPEC);
  const headSha = commit(directory, 'breaking change');

  const { outcome, io } = await runInRepository({ directory, specPath: 'openapi.yaml', baseSha, headSha });
  assert.equal(outcome.status, 'breaking');
  assert.equal(outcome.breakingCount, 1);
  assert.equal(outcome.baselineSha, baseSha);
  assert.equal(io.record.failed.length, 1);
  assert.match(io.record.summary[0], /RESPONSE_FIELD_REMOVED/);
});

test('a compatible change in a real repository passes the check', needsGit, async () => {
  const directory = newRepository();
  writeSpec(directory, 'openapi.yaml', BASE_SPEC);
  const baseSha = commit(directory, 'base');
  writeSpec(directory, 'openapi.yaml', COMPATIBLE_SPEC);
  const headSha = commit(directory, 'additive change');

  const { outcome, io } = await runInRepository({ directory, specPath: 'openapi.yaml', baseSha, headSha });
  assert.equal(outcome.status, 'compatible');
  assert.deepEqual(io.record.failed, []);
  assert.equal(io.record.outputs.breaking, 'false');
});

test('the baseline is the merge base when the base branch has moved on', needsGit, async () => {
  const directory = newRepository();
  writeSpec(directory, 'openapi.yaml', BASE_SPEC);
  const forkPoint = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  writeSpec(directory, 'openapi.yaml', COMPATIBLE_SPEC);
  const headSha = commit(directory, 'additive change on the feature branch');
  git(directory, ['checkout', '--quiet', 'main']);
  // Somebody else makes a breaking change on the base branch after this
  // pull request opened. It must not be attributed to this pull request.
  writeSpec(directory, 'openapi.yaml', BREAKING_SPEC);
  const baseTip = commit(directory, 'unrelated breaking change on main');
  git(directory, ['checkout', '--quiet', 'feature']);

  const { outcome } = await runInRepository({
    directory, specPath: 'openapi.yaml', baseSha: baseTip, headSha,
  });
  assert.equal(outcome.baselineSha, forkPoint, 'the fork point is the baseline');
  assert.equal(outcome.status, 'compatible', "another branch's change is not blamed on this one");
});

test('the synthetic merge checkout is measured against the base commit', needsGit, async () => {
  const directory = newRepository();
  writeSpec(directory, 'openapi.yaml', TWO_PATH_SPEC);
  commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '-b', 'feature']);
  writeSpec(directory, 'openapi.yaml', TWO_PATH_FEATURE);
  const featureHead = commit(directory, 'additive change on the feature branch');
  git(directory, ['checkout', '--quiet', 'main']);
  // Somebody else makes a breaking change on the base branch afterwards.
  writeSpec(directory, 'openapi.yaml', TWO_PATH_BASE_BREAKING);
  const baseTip = commit(directory, 'unrelated breaking change on main');

  // Reproduce what actions/checkout does by default on pull_request: a merge of
  // the pull request into the base branch, checked out detached.
  git(directory, ['checkout', '--quiet', '--detach', baseTip]);
  git(directory, ['merge', '--quiet', '--no-ff', '--no-edit', '--no-gpg-sign', featureHead]);
  const mergeCommit = git(directory, ['rev-parse', 'HEAD']);
  assert.notEqual(mergeCommit, baseTip, 'a merge commit is checked out');

  const { outcome } = await runInRepository({
    directory, specPath: 'openapi.yaml', baseSha: baseTip, headSha: featureHead,
  });
  // The working tree contains the base branch's breaking change, because the
  // merge pulled it in. Measuring from the fork point would blame this pull
  // request for it; measuring from the base commit does not.
  assert.equal(outcome.baselineSha, baseTip, 'the base commit is the baseline');
  assert.equal(outcome.status, 'compatible');
  assert.equal(outcome.breakingCount, 0);
});

test('the base branch breaking change is still found when it is the one under review', needsGit, async () => {
  // The mirror of the test above: the same breaking change, reviewed as its own
  // pull request, must be reported.
  const directory = newRepository();
  writeSpec(directory, 'openapi.yaml', TWO_PATH_SPEC);
  const baseSha = commit(directory, 'base');
  writeSpec(directory, 'openapi.yaml', TWO_PATH_BASE_BREAKING);
  const headSha = commit(directory, 'drop a response field');

  const { outcome } = await runInRepository({ directory, specPath: 'openapi.yaml', baseSha, headSha });
  assert.equal(outcome.status, 'breaking');
  assert.equal(outcome.breakingCount, 1);
});

test('unrelated histories fail with guidance instead of a guessed baseline', needsGit, async () => {
  const directory = newRepository();
  writeSpec(directory, 'openapi.yaml', BASE_SPEC);
  const baseSha = commit(directory, 'base');
  git(directory, ['checkout', '--quiet', '--orphan', 'unrelated']);
  git(directory, ['rm', '--quiet', '-rf', '.']);
  writeSpec(directory, 'openapi.yaml', COMPATIBLE_SPEC);
  const headSha = commit(directory, 'unrelated root');

  const { outcome } = await runInRepository({ directory, specPath: 'openapi.yaml', baseSha, headSha });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /Could not find a common ancestor/);
  assert.match(outcome.error, /fetch-depth: 0/);
  assert.match(outcome.error, /will not fall back to a different baseline/);
});

test('the git adapter resolves HEAD to a commit', needsGit, () => {
  const directory = newRepository();
  writeSpec(directory, 'openapi.yaml', BASE_SPEC);
  const sha = commit(directory, 'base');
  const access = createGitAccess(directory);
  assert.equal(access.resolveCommit('HEAD'), sha);
  assert.equal(access.resolveCommit('refs/heads/does-not-exist'), null);
});

test('a specification added only in the pull request is a clear error', needsGit, async () => {
  const directory = newRepository();
  writeSpec(directory, 'README.md', 'no specification yet\n');
  const baseSha = commit(directory, 'base without a specification');
  writeSpec(directory, 'openapi.yaml', BASE_SPEC);
  const headSha = commit(directory, 'add the specification');

  const { outcome } = await runInRepository({ directory, specPath: 'openapi.yaml', baseSha, headSha });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /does not exist at the/);
  assert.match(outcome.error, /will not report that as compatible/);
});

test('a shallow clone without the base commit explains fetch-depth', needsGit, async () => {
  const directory = newRepository();
  writeSpec(directory, 'openapi.yaml', BASE_SPEC);
  const baseSha = commit(directory, 'base');
  writeSpec(directory, 'openapi.yaml', COMPATIBLE_SPEC);
  const headSha = commit(directory, 'head');

  const shallow = mkdtempSync(join(tmpdir(), 'contractguard-shallow-'));
  repositories.push(shallow);
  const clone = join(shallow, 'repo');
  git(shallow, ['clone', '--quiet', '--depth', '1', `file://${directory.split('\\').join('/')}`, clone]);

  const { outcome } = await runInRepository({
    directory: clone, specPath: 'openapi.yaml', baseSha, headSha,
  });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /is not in the local clone/);
  assert.match(outcome.error, /fetch-depth: 0/);
});

test('a specification in a subdirectory is resolved against the repository root', needsGit, async () => {
  const directory = newRepository();
  writeSpec(directory, 'specs/openapi.yaml', BASE_SPEC);
  const baseSha = commit(directory, 'base');
  writeSpec(directory, 'specs/openapi.yaml', BREAKING_SPEC);
  const headSha = commit(directory, 'breaking change');

  // The workspace is a directory inside the repository, so a path resolved
  // against the working directory alone would not exist in the Git tree.
  const { outcome } = await runInRepository({
    directory,
    workspace: join(directory, 'specs'),
    specPath: 'openapi.yaml',
    baseSha,
    headSha,
  });
  assert.equal(outcome.status, 'breaking');
  assert.equal(outcome.breakingCount, 1);
});

test('a path with shell metacharacters works end to end', needsGit, async () => {
  const directory = newRepository();
  const hostile = 'my api $(touch pwned) & more.yaml';
  writeSpec(directory, hostile, BASE_SPEC);
  const baseSha = commit(directory, 'base');
  writeSpec(directory, hostile, BREAKING_SPEC);
  const headSha = commit(directory, 'breaking change');

  const { outcome } = await runInRepository({ directory, specPath: hostile, baseSha, headSha });
  assert.equal(outcome.status, 'breaking');
  assert.equal(existsSync(join(directory, 'pwned')), false);
});
