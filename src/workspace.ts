import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { FileAccess } from './integration';

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
  };
}
