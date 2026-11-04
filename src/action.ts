import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath, relative, isAbsolute, sep } from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { compareSpecifications } from './comparator';
import { loadSpecification } from './load';
import { renderMarkdown } from './report';

type Octokit = ReturnType<typeof github.getOctokit>;
type IssueComment = Awaited<ReturnType<Octokit['rest']['issues']['listComments']>>['data'][number];

async function main(): Promise<void> {
  try {
    const path = core.getInput('spec-path', { required: true });
    const relativePath = relative(process.cwd(), resolvePath(path));
    if (isAbsolute(path) || (relativePath === '..' || relativePath.startsWith(`..${sep}`)) || relativePath === '') {
      throw new Error('spec-path must be a file inside the checked-out repository.');
    }
    const pr = github.context.payload.pull_request;
    if (!pr) throw new Error('ContractGuard currently runs on pull_request events only.');
    const beforeText = execFileSync('git', ['show', `${pr.base.sha}:${relativePath.replaceAll('\\', '/')}`], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    const afterText = readFileSync(resolvePath(path), 'utf8');
    const before = loadSpecification(beforeText);
    const after = loadSpecification(afterText);
    const result = compareSpecifications(before, after);
    const report = renderMarkdown(result);
    core.info(report);
    core.setOutput('breaking-count', String(result.breaking.length));
    core.setOutput('breaking', String(result.breaking.length > 0));
    await core.summary.addRaw(report).write();

    const token = core.getInput('github-token');
    if (core.getBooleanInput('comment') && token) {
      const octokit = github.getOctokit(token);
      const { owner, repo } = github.context.repo;
      const issue_number = pr.number;
      try {
        const comments: IssueComment[] = await octokit.paginate(octokit.rest.issues.listComments, {
          owner, repo, issue_number, per_page: 100,
        });
        const previous = comments.find((comment: IssueComment) =>
          comment.user?.type === 'Bot' && comment.body?.includes('<!-- contractguard-report -->'));
        if (previous) {
          await octokit.rest.issues.updateComment({ owner, repo, comment_id: previous.id, body: report });
        } else {
          await octokit.rest.issues.createComment({ owner, repo, issue_number, body: report });
        }
      } catch (error) {
        core.warning(`Could not post PR comment (often expected for fork PRs): ${String(error)}`);
      }
    }
    if (result.breaking.length > 0) {
      core.setFailed(`ContractGuard detected ${result.breaking.length} potentially breaking API changes.`);
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

void main();
