import { spawnSync } from 'node:child_process';
import type { GitAccess, GitEntry } from './integration';
import type { DocumentSource, SourceRead } from './references';

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
    entryAt(commit: string, repositoryPath: string): GitEntry | null {
      // `--full-tree` makes the path repository-relative whatever the working
      // directory is, `-z` leaves the path unquoted, and `--literal-pathspecs`
      // stops `*`, `?`, `[` and a leading `:` in a file name acting as a pattern.
      const result = run(['--literal-pathspecs', 'ls-tree', '--long', '--full-tree', '-z', commit, '--', repositoryPath]);
      if (result.status !== 0) return null;
      const line = result.stdout.split('\0')[0] ?? '';
      const match = /^(\d+) (\w+) [0-9a-f]+ +(\d+|-)\t([\s\S]*)$/.exec(line);
      if (!match || match[4] !== repositoryPath) return null;
      return { mode: match[1], type: match[2], size: match[3] === '-' ? 0 : Number(match[3]) };
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

/**
 * Reads referenced files from one Git revision, so the baseline resolves every
 * dependency from the baseline commit and never from the working tree.
 *
 * A symbolic link is stored in Git as a blob holding its target path. Reading
 * it as a file would silently parse that path as the document, so a link, or a
 * path that passes through one, is refused by name instead.
 */
export function createRevisionSource(git: GitAccess, commit: string, boundary: string, origin: string): DocumentSource {
  const SYMLINK_MODE = '120000';
  return {
    boundary,
    origin,
    read(path: string, maxBytes: number): SourceRead {
      const entry = git.entryAt(commit, path);
      if (entry === null) {
        const parts = path.split('/');
        for (let length = 1; length < parts.length; length++) {
          const ancestor = git.entryAt(commit, parts.slice(0, length).join('/'));
          if (ancestor !== null && ancestor.mode === SYMLINK_MODE) return { status: 'symlink' };
        }
        return { status: 'missing' };
      }
      if (entry.mode === SYMLINK_MODE) return { status: 'symlink' };
      if (entry.type !== 'blob') return { status: 'not-file' };
      if (entry.size > maxBytes) return { status: 'too-large', limit: maxBytes };
      try {
        return { status: 'ok', text: git.readFileAt(commit, path) };
      } catch (error) {
        return { status: 'unreadable', detail: error instanceof Error ? error.message.split('\n')[0] : String(error) };
      }
    },
  };
}
