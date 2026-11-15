import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileAccess } from './integration';
import type { DocumentSource, SourceRead } from './references';

/**
 * Writes a file under `boundaryRoot`, and nowhere else.
 *
 * The caller has already checked that `repositoryPath` is relative and inside
 * the root. This guards what the path *meets on disk*: in a checkout of an
 * untrusted change, any directory or the file itself may have been replaced by
 * a symbolic link that leads outside the repository. So every component is
 * inspected without following links, a link anywhere is refused, a directory or
 * other special file at the target is refused, and the file is opened with
 * `O_NOFOLLOW` so a link swapped in after the check is refused as well.
 */
export function writeRepositoryFile(boundaryRoot: string, repositoryPath: string, contents: string): void {
  const parts = repositoryPath.split('/').filter(part => part !== '');
  if (parts.length === 0 || parts.includes('..') || parts.includes('.')) {
    throw new Error('the path is not a plain relative file path');
  }
  let current = resolve(boundaryRoot);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const last = index === parts.length - 1;
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!last) mkdirSync(current);
      continue;
    }
    if (stats.isSymbolicLink()) throw new Error(`"${parts.slice(0, index + 1).join('/')}" is a symbolic link, which is never followed`);
    if (!last && !stats.isDirectory()) throw new Error(`"${parts.slice(0, index + 1).join('/')}" is not a directory`);
    if (last && !stats.isFile()) throw new Error(`"${repositoryPath}" exists and is not a regular file`);
  }
  const descriptor = openSync(current, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    const data = Buffer.from(contents, 'utf8');
    let offset = 0;
    while (offset < data.length) offset += writeSync(descriptor, data, offset, data.length - offset);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Reads referenced files from a directory tree, never leaving it.
 *
 * Every path component under the boundary is inspected without following
 * links, and a symbolic link anywhere on the way is refused rather than
 * followed: a link inside an approved directory can point anywhere, and the
 * checkout the Action reads is exactly the place an untrusted change could
 * plant one. The file itself is opened with `O_NOFOLLOW` where the platform has
 * it, so a link swapped in after the check is refused too.
 */
export function createDirectorySource(boundaryDirectory: string, boundary: string, origin: string): DocumentSource {
  const base = resolve(boundaryDirectory);
  return {
    boundary,
    origin,
    read(path: string, maxBytes: number): SourceRead {
      const parts = path.split('/');
      let current = base;
      for (let index = 0; index < parts.length; index++) {
        current = join(current, parts[index]);
        let stats;
        try {
          stats = lstatSync(current);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing' };
          return { status: 'unreadable', detail: code ?? 'unknown error' };
        }
        if (stats.isSymbolicLink()) return { status: 'symlink' };
        const last = index === parts.length - 1;
        if (!last && !stats.isDirectory()) return { status: 'missing' };
        if (last && !stats.isFile()) return { status: 'not-file' };
        if (last && stats.size > maxBytes) return { status: 'too-large', limit: maxBytes };
      }
      let descriptor: number | null = null;
      try {
        descriptor = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(descriptor);
        if (!opened.isFile()) return { status: 'not-file' };
        if (opened.size > maxBytes) return { status: 'too-large', limit: maxBytes };
        const buffer = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < buffer.length) {
          const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
          if (count === 0) break;
          offset += count;
        }
        return { status: 'ok', text: buffer.toString('utf8', 0, offset) };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP') return { status: 'symlink' };
        if (code === 'ENOENT') return { status: 'missing' };
        return { status: 'unreadable', detail: code ?? 'unknown error' };
      } finally {
        if (descriptor !== null) closeSync(descriptor);
      }
    },
  };
}

/**
 * Filesystem access rooted at the workspace directory. Paths are reported with
 * `/` separators so a Windows runner produces the same repository-relative path
 * that Git expects.
 */
export function createWorkspace(workspace: string): FileAccess {
  return {
    isAbsolute(path: string): boolean {
      return isAbsolute(path);
    },
    resolve(path: string): string {
      return resolve(workspace, path);
    },
    relativeTo(root: string, absolute: string): string | null {
      const relativePath = relative(resolve(root), absolute);
      if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)
        || relativePath.startsWith('../') || isAbsolute(relativePath)) {
        return null;
      }
      return relativePath.split(sep).join('/');
    },
    exists(absolutePath: string): boolean {
      return existsSync(absolutePath) && statSync(absolutePath).isFile();
    },
    read(absolutePath: string): string {
      return readFileSync(absolutePath, 'utf8');
    },
    writeFile: writeRepositoryFile,
    source(boundaryRoot: string, origin: string): DocumentSource {
      return createDirectorySource(boundaryRoot, 'the repository', origin);
    },
  };
}
