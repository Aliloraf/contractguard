import { spawnSync } from 'node:child_process';
import type { GitAccess } from './integration';

/** Generous enough for large specifications, bounded so a runaway cannot grow without limit. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs Git with an explicit argument list.
 *
 * No shell is involved, so nothing in a path, ref or other caller-supplied
 * value can be interpreted as a command. A failing command returns its status
 * instead of throwing, which lets callers tell "this file is absent" apart from
 * "Git could not run".
 */
export function runGit(cwd: string, args: string[]): GitResult {
  const outcome = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
  });
  if (outcome.error) {
    throw new Error(`Could not run git ${args[0] ?? ''}: ${outcome.error.message}`);
  }
  return {
    status: outcome.status ?? -1,
    stdout: outcome.stdout ?? '',
    stderr: outcome.stderr ?? '',
  };
}

export function createGitAccess(cwd: string): GitAccess {
  const run = (args: string[]): GitResult => runGit(cwd, args);
  return {
    repositoryRoot(): string | null {
      const result = run(['rev-parse', '--show-toplevel']);
      if (result.status !== 0) return null;
      const root = result.stdout.trim();
      return root === '' ? null : root;
    },
    commitExists(commit: string): boolean {
      return run(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]).status === 0;
    },
    resolveCommit(revision: string): string | null {
      const result = run(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
      if (result.status !== 0) return null;
      const sha = result.stdout.trim();
      return sha === '' ? null : sha;
    },
    mergeBase(left: string, right: string): string | null {
      const result = run(['merge-base', left, right]);
      if (result.status !== 0) return null;
      const sha = result.stdout.trim();
      return sha === '' ? null : sha;
    },
    fileExistsAt(commit: string, repositoryPath: string): boolean {
      return run(['cat-file', '-e', `${commit}:${repositoryPath}`]).status === 0;
    },
    readFileAt(commit: string, repositoryPath: string): string {
      const result = run(['show', `${commit}:${repositoryPath}`]);
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `git show exited with status ${result.status}`);
      }
      return result.stdout;
    },
  };
}
