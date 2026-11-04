import { compareSpecifications } from './comparator';
import { loadSpecification } from './load';
import { REPORT_MARKER, renderMarkdown } from './report';

/** A commit-ish accepted from the event payload, before it reaches Git. */
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/**
 * The account the default GITHUB_TOKEN posts as. An installation token cannot
 * read `/user`, so this is the identity assumed when the API will not name one.
 * No human account can hold this login, because `[` and `]` are not legal in
 * GitHub usernames.
 */
export const ACTIONS_BOT_LOGIN = 'github-actions[bot]';

export interface ActionInputs {
  specPath: string;
  comment: boolean;
  githubToken: string;
}

export interface PullRequestContext {
  number: number;
  baseSha: string;
  /**
   * The pull request head from the event payload. Used only for diagnostics:
   * the baseline is derived from the commit that is actually checked out, which
   * is the synthetic merge commit unless the workflow asked for something else.
   */
  headSha: string;
  /** True when the head branch lives in another repository. */
  isFork: boolean;
}

export interface EventContext {
  eventName: string;
  pullRequest: PullRequestContext | null;
}

/** Read-only Git access. Every implementation must pass arguments explicitly. */
export interface GitAccess {
  /** Absolute path of the working tree root, or `null` when there is none. */
  repositoryRoot(): string | null;
  commitExists(commit: string): boolean;
  /** The full SHA a revision names, or `null` when it cannot be resolved. */
  resolveCommit(revision: string): string | null;
  /** The best common ancestor, or `null` when there is none or Git failed. */
  mergeBase(left: string, right: string): string | null;
  fileExistsAt(commit: string, repositoryPath: string): boolean;
  readFileAt(commit: string, repositoryPath: string): string;
}

export interface FileAccess {
  isAbsolute(path: string): boolean;
  /** Resolves against the workspace directory. */
  resolve(path: string): string;
  /**
   * The path of `absolute` inside `root`, with `/` separators, or `null` when
   * it falls outside `root`.
   */
  relativeTo(root: string, absolute: string): string | null;
  exists(absolutePath: string): boolean;
  read(absolutePath: string): string;
}

export interface ActionIo {
  info(message: string): void;
  warning(message: string): void;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  writeSummary(markdown: string): Promise<void>;
}

export interface ExistingComment {
  id: number;
  body: string | null;
  /** Login of the account that wrote the comment, as GitHub reports it. */
  author: string | null;
}

/** Which account the configured token writes as. */
export interface CommentIdentity {
  login: string;
  /** False when the login was assumed rather than read back from the API. */
  verified: boolean;
}

export interface CommentApi {
  /** Resolves the token's own account, so ownership can be established. */
  identity(): Promise<CommentIdentity>;
  list(): Promise<ExistingComment[]>;
  update(id: number, body: string): Promise<void>;
  create(body: string): Promise<void>;
}

export interface ActionEnvironment {
  inputs: ActionInputs;
  context: EventContext;
  git: GitAccess;
  files: FileAccess;
  io: ActionIo;
  /** Absent when no token was supplied, so commenting is impossible. */
  comments: CommentApi | null;
}

export type ActionStatus = 'compatible' | 'breaking' | 'failed';
export type CommentOutcome = 'created' | 'updated' | 'skipped' | 'failed' | 'disabled';

export interface ActionOutcome {
  status: ActionStatus;
  breakingCount: number;
  noticeCount: number;
  report: string | null;
  error: string | null;
  baselineSha: string | null;
  comment: CommentOutcome;
}

/** An explained, user-facing failure, as opposed to an unexpected crash. */
export class ActionFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionFailure';
  }
}

function fail(message: string): never {
  throw new ActionFailure(message);
}

function short(commit: string): string {
  return commit.slice(0, 7);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SpecLocation {
  absolute: string;
  repositoryPath: string;
}

/**
 * Keeps the Action pointed at a file inside the checkout. The path comes from
 * workflow input, so it is validated before it reaches Git or the filesystem.
 */
function locateSpecification(input: string, root: string, files: FileAccess): SpecLocation {
  const requested = input.trim();
  if (requested === '') fail('spec-path must not be empty.');
  if (requested.includes('\0')) fail('spec-path must not contain NUL characters.');
  if (files.isAbsolute(requested)) {
    fail(`spec-path must be relative to the repository, but "${input}" is an absolute path.`);
  }
  const absolute = files.resolve(requested);
  const repositoryPath = files.relativeTo(root, absolute);
  if (repositoryPath === null || repositoryPath === '') {
    fail(`spec-path must point to a file inside the repository, but "${input}" resolves outside it.`);
  }
  return { absolute, repositoryPath };
}

interface Baseline {
  sha: string;
  description: string;
}

/**
 * Picks the commit the pull request is measured against: the common ancestor of
 * the base branch and whatever is checked out.
 *
 * Taking the merge base against the **checked-out HEAD** rather than the head
 * SHA from the event payload is what makes both checkout styles correct. With
 * the default `pull_request` checkout, HEAD is GitHub's synthetic merge commit,
 * the base commit is already one of its parents, and the merge base is that base
 * commit — the right baseline, because the working tree also contains whatever
 * the base branch has gained since the pull request diverged. When a workflow
 * checks out `head.sha` instead, the working tree holds only the pull request's
 * own commits and the merge base is the point where it diverged, which is again
 * the right baseline.
 *
 * There is deliberately no fallback. If the common ancestor cannot be found the
 * history is incomplete, and quietly measuring against some other commit would
 * report changes the pull request did not make, or miss ones it did.
 */
function resolveBaseline(pr: PullRequestContext, git: GitAccess, io: ActionIo): Baseline {
  const baseSha = pr.baseSha.trim().toLowerCase();
  if (!SHA_PATTERN.test(baseSha)) {
    fail('The pull_request event did not provide a usable base commit SHA.');
  }
  if (!git.commitExists(baseSha)) {
    fail(`The base commit ${short(baseSha)} is not in the local clone, so the previous specification cannot be read. `
      + 'Check out with "fetch-depth: 0" (or any depth that includes the base commit) before running ContractGuard.');
  }

  const head = git.resolveCommit('HEAD');
  if (head === null) {
    fail('Could not resolve HEAD in the workspace. Run actions/checkout before ContractGuard.');
  }

  const found = git.mergeBase(baseSha, 'HEAD');
  const mergeBase = found === null ? null : found.trim().toLowerCase();
  if (mergeBase === null || !SHA_PATTERN.test(mergeBase) || !git.commitExists(mergeBase)) {
    fail(`Could not find a common ancestor of the base commit ${short(baseSha)} and the checked-out commit `
      + `${short(head)}. That history is usually missing because the clone is too shallow. Check out with `
      + '"fetch-depth: 0" (or any depth that includes both commits). ContractGuard will not fall back to a '
      + 'different baseline, because comparing against the wrong commit can report a misleading result.');
  }

  const headNote = SHA_PATTERN.test(pr.headSha.trim().toLowerCase()) && pr.headSha.trim().toLowerCase() === head
    ? 'the pull request head'
    : 'a merge of the pull request into the base branch';
  if (mergeBase === baseSha) {
    io.info(`Comparing ${headNote} (${short(head)}) against the base commit ${short(baseSha)}.`);
    return { sha: mergeBase, description: `base commit ${short(baseSha)}` };
  }
  io.info(`Comparing ${headNote} (${short(head)}) against the merge base ${short(mergeBase)}; `
    + `the base branch is now at ${short(baseSha)}.`);
  return { sha: mergeBase, description: `merge base ${short(mergeBase)}` };
}

function parseSpecification(text: string, origin: string): ReturnType<typeof loadSpecification> {
  try {
    return loadSpecification(text);
  } catch (error) {
    fail(`The specification from ${origin} could not be read: ${describe(error)}`);
  }
}

/** Case-insensitive login comparison, as GitHub treats logins. */
function sameAccount(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

/**
 * Posts or updates the report comment.
 *
 * The marker alone does not establish ownership: anyone who can comment on the
 * pull request could paste it and have their comment overwritten on every run.
 * A comment is only edited when it carries the marker **and** was written by the
 * account the configured token acts as, which covers both the Actions bot and a
 * personal access token. When ownership cannot be established the report is
 * posted as a new comment instead, so a wrong comment is never edited.
 *
 * Commenting stays optional and best effort: every failure is downgraded to a
 * warning so it can never hide, or be mistaken for, the compatibility result.
 */
async function syncComment(env: ActionEnvironment, report: string): Promise<CommentOutcome> {
  const { inputs, context, io, comments } = env;
  if (!inputs.comment) return 'disabled';
  if (inputs.githubToken.trim() === '' || comments === null) {
    io.warning('comment: true needs a github-token with pull-requests: write permission. '
      + 'Skipping the pull request comment; the compatibility result is unaffected.');
    return 'skipped';
  }
  const forkNote = context.pullRequest?.isFork
    ? ' This is expected for pull requests from forks, where GITHUB_TOKEN is read-only.'
    : '';
  try {
    let identity: CommentIdentity | null = null;
    try {
      identity = await comments.identity();
    } catch (error) {
      io.warning(`Could not establish which account the token posts as (${describe(error)}), so an existing `
        + 'report cannot be confirmed as ContractGuard\'s own. Posting a new comment instead of editing one.');
    }
    if (identity !== null && !identity.verified) {
      io.info(`The token's account could not be read from the API, which is normal for GITHUB_TOKEN; `
        + `assuming comments are owned by ${identity.login}.`);
    }

    const existing = await comments.list();
    const marked = existing.filter(comment => comment.body !== null && comment.body.includes(REPORT_MARKER));
    const owned = identity === null
      ? []
      : marked.filter(comment => sameAccount(comment.author, identity.login));

    if (owned.length > 0) {
      await comments.update(owned[0].id, report);
      return 'updated';
    }
    if (marked.length > 0) {
      const authors = [...new Set(marked.map(comment => comment.author ?? 'an unknown account'))];
      io.warning(`Ignoring ${marked.length} comment(s) that carry the ContractGuard marker but were written by `
        + `${authors.join(', ')} rather than ${identity === null ? 'this token\'s account' : identity.login}. `
        + 'ContractGuard only edits its own comments, so the report is posted as a new comment.');
    }
    await comments.create(report);
    return 'created';
  } catch (error) {
    io.warning(`Could not post the pull request comment: ${describe(error)}.${forkNote} `
      + 'The compatibility result is unaffected.');
    return 'failed';
  }
}

async function execute(env: ActionEnvironment): Promise<ActionOutcome> {
  const { inputs, context, git, files, io } = env;

  if (context.eventName === 'pull_request_target') {
    fail('ContractGuard does not run on pull_request_target. That event hands a writable token to a '
      + 'workflow that would be inspecting untrusted changes, and its checkout is the base branch, so the '
      + 'comparison would silently pass. Use the pull_request event instead.');
  }
  const pr = context.pullRequest;
  if (!pr) {
    fail(`ContractGuard runs on pull_request events only, but the event was "${context.eventName || 'unknown'}". `
      + 'Use the CLI to compare two specification files outside a pull request.');
  }

  const root = git.repositoryRoot();
  if (root === null) {
    fail('No Git repository was found in the workspace. Run actions/checkout before ContractGuard.');
  }

  const spec = locateSpecification(inputs.specPath, root, files);
  if (!files.exists(spec.absolute)) {
    fail(`The specification "${spec.repositoryPath}" is missing from the checkout. `
      + 'ContractGuard will not report a missing specification as compatible.');
  }

  const baseline = resolveBaseline(pr, git, io);
  if (!git.fileExistsAt(baseline.sha, spec.repositoryPath)) {
    fail(`"${spec.repositoryPath}" does not exist at the ${baseline.description}, so there is no baseline to `
      + 'compare against, and ContractGuard will not report that as compatible. If this specification is new in '
      + 'this pull request, there is nothing to compare yet.');
  }

  let baseText: string;
  try {
    baseText = git.readFileAt(baseline.sha, spec.repositoryPath);
  } catch (error) {
    fail(`Could not read "${spec.repositoryPath}" at the ${baseline.description}: ${describe(error)}`);
  }
  let headText: string;
  try {
    headText = files.read(spec.absolute);
  } catch (error) {
    fail(`Could not read "${spec.repositoryPath}" from the checkout: ${describe(error)}`);
  }

  const baseSpec = parseSpecification(baseText, `the ${baseline.description}`);
  const headSpec = parseSpecification(headText, 'this pull request');
  const result = compareSpecifications(baseSpec, headSpec);
  const report = renderMarkdown(result);
  const breakingCount = result.breaking.length;
  const noticeCount = result.notices.length;

  io.info(report);
  io.setOutput('breaking', String(breakingCount > 0));
  io.setOutput('breaking-count', String(breakingCount));
  io.setOutput('notice-count', String(noticeCount));

  try {
    await io.writeSummary(report);
  } catch (error) {
    io.warning(`Could not write the job summary: ${describe(error)}. The compatibility result is unaffected.`);
  }

  if (noticeCount > 0) {
    io.warning(`${noticeCount} place${noticeCount === 1 ? '' : 's'} could not be evaluated and need a manual review. `
      + 'See the job summary; a clean result is not a guarantee of compatibility there.');
  }

  const comment = await syncComment(env, report);

  if (breakingCount > 0) {
    io.setFailed(`ContractGuard detected ${breakingCount} potentially breaking API change${breakingCount === 1 ? '' : 's'}.`);
    return { status: 'breaking', breakingCount, noticeCount, report, error: null, baselineSha: baseline.sha, comment };
  }
  io.info(`No breaking changes detected against the ${baseline.description}.`);
  return { status: 'compatible', breakingCount, noticeCount, report, error: null, baselineSha: baseline.sha, comment };
}

/**
 * Runs the Action against an injected environment. Every failure path reports a
 * message rather than a stack trace, and no failure is ever reported as a
 * compatible result.
 */
export async function runContractGuard(env: ActionEnvironment): Promise<ActionOutcome> {
  try {
    return await execute(env);
  } catch (error) {
    const message = error instanceof ActionFailure
      ? error.message
      : `ContractGuard failed unexpectedly: ${describe(error)}`;
    env.io.setFailed(message);
    return {
      status: 'failed',
      breakingCount: 0,
      noticeCount: 0,
      report: null,
      error: message,
      baselineSha: null,
      comment: 'disabled',
    };
  }
}
