import * as core from '@actions/core';
import * as github from '@actions/github';
import { createGitAccess } from './git';
import {
  ACTIONS_BOT_LOGIN,
  ActionEnvironment,
  CommentApi,
  CommentIdentity,
  EventContext,
  ExistingComment,
  PullRequestContext,
  runContractGuard,
} from './integration';
import { createWorkspace } from './workspace';

type Octokit = ReturnType<typeof github.getOctokit>;
type IssueComment = Awaited<ReturnType<Octokit['rest']['issues']['listComments']>>['data'][number];

function readBoolean(name: string): boolean {
  // getBooleanInput throws on anything that is not a YAML boolean, which is a
  // clearer failure than silently treating a typo as false.
  try {
    return core.getBooleanInput(name);
  } catch {
    throw new Error(`Input "${name}" must be true or false.`);
  }
}

function readPullRequest(): PullRequestContext | null {
  const payload = github.context.payload.pull_request;
  if (!payload) return null;
  const base = payload.base as { sha?: unknown; repo?: { full_name?: unknown } } | undefined;
  const head = payload.head as { sha?: unknown; repo?: { full_name?: unknown } } | undefined;
  const baseRepo = typeof base?.repo?.full_name === 'string' ? base.repo.full_name : null;
  const headRepo = typeof head?.repo?.full_name === 'string' ? head.repo.full_name : null;
  return {
    number: typeof payload.number === 'number' ? payload.number : 0,
    baseSha: typeof base?.sha === 'string' ? base.sha : '',
    headSha: typeof head?.sha === 'string' ? head.sha : '',
    isFork: baseRepo !== null && headRepo !== null && baseRepo !== headRepo,
  };
}

function createCommentApi(token: string, issueNumber: number): CommentApi {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  return {
    async identity(): Promise<CommentIdentity> {
      try {
        const authenticated = await octokit.rest.users.getAuthenticated();
        return { login: authenticated.data.login, verified: true };
      } catch {
        // An installation token, including the default GITHUB_TOKEN, is not
        // allowed to read /user. Such a token comments as the Actions bot.
        return { login: ACTIONS_BOT_LOGIN, verified: false };
      }
    },
    async list(): Promise<ExistingComment[]> {
      const comments: IssueComment[] = await octokit.paginate(octokit.rest.issues.listComments, {
        owner, repo, issue_number: issueNumber, per_page: 100,
      });
      return comments.map((comment: IssueComment) => ({
        id: comment.id,
        body: typeof comment.body === 'string' ? comment.body : null,
        author: typeof comment.user?.login === 'string' ? comment.user.login : null,
      }));
    },
    async update(id: number, body: string): Promise<void> {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: id, body });
    },
    async create(body: string): Promise<void> {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    },
  };
}

async function main(): Promise<void> {
  try {
    const workspace = process.env.GITHUB_WORKSPACE?.trim() || process.cwd();
    const pullRequest = readPullRequest();
    const token = core.getInput('github-token');
    const comment = readBoolean('comment');
    const context: EventContext = {
      eventName: github.context.eventName || process.env.GITHUB_EVENT_NAME || '',
      pullRequest,
    };
    const environment: ActionEnvironment = {
      inputs: {
        specPath: core.getInput('spec-path', { required: true }),
        comment,
        githubToken: token,
      },
      context,
      git: createGitAccess(workspace),
      files: createWorkspace(workspace),
      io: {
        info: (message: string) => core.info(message),
        warning: (message: string) => core.warning(message),
        setOutput: (name: string, value: string) => core.setOutput(name, value),
        setFailed: (message: string) => core.setFailed(message),
        writeSummary: async (markdown: string) => {
          await core.summary.addRaw(markdown).write();
        },
      },
      comments: comment && token.trim() !== '' && pullRequest
        ? createCommentApi(token, pullRequest.number)
        : null,
    };
    await runContractGuard(environment);
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

void main();
