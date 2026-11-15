import { parse } from 'yaml';
import { childOf, record } from './schema';
import type { JsonObject } from './types';

/**
 * Multi-file reference support.
 *
 * The comparison engine resolves `#/...` pointers against one document object.
 * Rather than teach every rule about files, the loader folds the files a
 * specification reaches into that one object: each referenced file is stored,
 * once, under a reserved root key, and every `$ref` is rewritten to the
 * internal pointer of its target.
 *
 * The rewriting is what keeps the source-file context correct. A reference is
 * resolved against the file that *contains* it, at load time, and the result is
 * an absolute pointer into the folded document, so by the time the comparator
 * follows it nothing is relative any more. Recursive and mutually recursive
 * schemas stay recursive (references are rewritten, never inlined), so the
 * engine's existing cycle handling applies across files unchanged.
 *
 * Each side of a comparison is folded on its own from its own revision, so the
 * baseline never sees a file from the head or the other way round.
 */

/** Reserved root key that holds the referenced files, keyed by normalised path. */
export const EXTERNAL_FILES_KEY = 'x-contractguard-files';

export interface ReferenceLimits {
  /** Most files, besides the root document, that one specification may pull in. */
  maxFiles: number;
  /** Largest single referenced file, in bytes. */
  maxFileBytes: number;
  /** Combined size of every referenced file, in bytes. */
  maxTotalBytes: number;
  /** Most JSON values walked across all files, which bounds the work done. */
  maxNodes: number;
  /** Deepest nesting walked inside one file. */
  maxDepth: number;
}

export const DEFAULT_REFERENCE_LIMITS: ReferenceLimits = {
  maxFiles: 500,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxNodes: 5_000_000,
  maxDepth: 128,
};

export type SourceRead =
  | { status: 'ok'; text: string }
  | { status: 'missing' }
  | { status: 'symlink' }
  | { status: 'not-file' }
  | { status: 'too-large'; limit: number }
  | { status: 'unreadable'; detail: string };

/**
 * Where referenced files come from: a directory on disk, or one Git revision.
 * Paths are relative to the boundary root with `/` separators and have already
 * been normalised, so they contain no `.` or `..` segment.
 */
export interface DocumentSource {
  /** What the boundary is, for messages: "the repository", "the directory …". */
  readonly boundary: string;
  /** Where files are read from, for messages: "the checkout", "commit abc1234". */
  readonly origin: string;
  read(path: string, maxBytes: number): SourceRead;
}

/** A reference that could not be resolved, with a message that names the cause. */
export class DocumentLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentLoadError';
  }
}

const SUPPORTED_EXTENSIONS = ['.yaml', '.yml', '.json'] as const;

/**
 * Keys whose value is data, never a schema or an OpenAPI object. A `$ref`-shaped
 * string in an example or an enum is content to preserve, not a reference.
 */
const DATA_KEYS: ReadonlySet<string> = new Set(['example', 'default', 'enum', 'const', 'value']);

/**
 * Keys whose value is a map from an author-chosen name to an object. Inside such
 * a map the names are never keywords, so a property called `default`, or a
 * response called `default`, is not mistaken for data.
 */
const NAME_MAP_KEYS: ReadonlySet<string> = new Set([
  'properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions', 'dependencies',
  'schemas', 'responses', 'parameters', 'headers', 'requestBodies', 'securitySchemes', 'links',
  'callbacks', 'pathItems', 'content', 'encoding', 'variables', 'mapping', 'scopes', 'paths',
  'webhooks',
]);

function setOwn(target: JsonObject, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointerOf(tokens: readonly string[]): string {
  return tokens.length === 0 ? '#' : `#/${tokens.map(escapeToken).join('/')}`;
}

/**
 * Collapses `.` and `..` segments of a `/` separated path. Returns `null` when
 * the path climbs above its starting point, which is how a traversal out of the
 * boundary is recognised.
 */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join('/');
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function hasSupportedExtension(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return SUPPORTED_EXTENSIONS.some(extension => name.endsWith(extension) && name.length > extension.length);
}

interface ParsedReference {
  /** The file part, percent-decoded; empty when the reference is `#...` only. */
  file: string;
  /** The JSON Pointer tokens; empty for the whole document. */
  tokens: string[];
}

function decode(text: string, what: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new Error(`${what} has an invalid percent-encoding`);
  }
}

/** Splits a `$ref` into file and pointer. Throws a reason, without context, when it is unsupported. */
function parseReference(ref: string): ParsedReference {
  const hash = ref.indexOf('#');
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? '' : ref.slice(hash + 1);

  let file = '';
  if (filePart !== '') {
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(filePart);
    if (scheme) {
      const name = scheme[1].toLowerCase();
      if (name === 'http' || name === 'https') {
        throw new Error('remote references are not supported; ContractGuard never fetches anything over the network');
      }
      if (name.length === 1) throw new Error('absolute paths are not supported; use a path relative to the referencing file');
      throw new Error(`the "${scheme[1]}:" URI scheme is not supported; only relative paths to local files are`);
    }
    if (filePart.startsWith('//')) {
      throw new Error('network-path references are not supported; only relative paths to local files are');
    }
    if (filePart.startsWith('/') || filePart.startsWith('\\')) {
      throw new Error('absolute paths are not supported; use a path relative to the referencing file');
    }
    if (filePart.includes('?')) throw new Error('query strings in file references are not supported');
    file = decode(filePart, 'the file path');
    if (file.includes('\\')) throw new Error('backslashes are not allowed in file paths; use "/"');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(file)) throw new Error('the file path contains control characters');
  }

  if (fragment === '') return { file, tokens: [] };
  const pointer = decode(fragment, 'the fragment');
  if (!pointer.startsWith('/')) {
    throw new Error(`the fragment "#${pointer}" is not a JSON Pointer; anchors and named fragments are not supported`);
  }
  const tokens = pointer.slice(1).split('/').map(token => {
    if (/~(?![01])/.test(token)) {
      throw new Error(`the fragment "#${pointer}" is not a valid JSON Pointer ("~" must be followed by 0 or 1)`);
    }
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
  });
  return { file, tokens };
}

interface PendingTarget {
  file: string;
  tokens: string[];
  ref: string;
  from: string;
  where: string;
}

interface LoadedFile {
  data: unknown;
}

class Loader {
  private readonly parsed = new Map<string, LoadedFile>();
  private readonly folded: JsonObject = {};
  private readonly queue: string[] = [];
  private readonly firstReferrer = new Map<string, PendingTarget>();
  private readonly pending: PendingTarget[] = [];
  private readonly chainStarts = new Set<string>();
  private nodes = 0;
  private totalBytes = 0;
  externalReferences = 0;

  constructor(
    private readonly rootPath: string,
    private readonly rootData: unknown,
    private readonly source: DocumentSource,
    private readonly limits: ReferenceLimits,
  ) {
    this.parsed.set(rootPath, { data: rootData });
  }

  run(): JsonObject | null {
    const rewrittenRoot = this.rewriteFile(this.rootPath, this.rootData);
    // Breadth first, so a failure is attributed to the shallowest referrer and
    // the order never depends on how deep a chain happens to go.
    for (let index = 0; index < this.queue.length; index++) {
      const path = this.queue[index];
      const data = this.loadFile(path);
      setOwn(this.folded, path, this.rewriteFile(path, data));
    }
    if (this.queue.length === 0 && this.externalReferences === 0) return null;

    this.validateTargets();
    const bundle = record(rewrittenRoot);
    if (Object.prototype.hasOwnProperty.call(bundle, EXTERNAL_FILES_KEY)) {
      throw new DocumentLoadError(`${this.rootPath}: the root key "${EXTERNAL_FILES_KEY}" is reserved by ContractGuard.`);
    }
    const result: JsonObject = { ...bundle };
    result[EXTERNAL_FILES_KEY] = this.folded;
    this.rejectAliasCycles(result);
    return result;
  }

  private fail(target: Pick<PendingTarget, 'ref' | 'from' | 'where'>, reason: string): never {
    throw new DocumentLoadError(
      `Cannot resolve $ref "${target.ref}" in ${target.from} (at ${target.where}): ${reason}.`);
  }

  private spend(file: string): void {
    if (++this.nodes > this.limits.maxNodes) {
      throw new DocumentLoadError(
        `The referenced documents are too large to load: more than ${this.limits.maxNodes} values `
        + `were read (stopped in ${file}).`);
    }
  }

  private loadFile(path: string): unknown {
    const referrer = this.firstReferrer.get(path);
    if (!referrer) throw new Error(`Internal error: ${path} was queued without a referrer.`);
    if (this.parsed.size > this.limits.maxFiles) {
      this.fail(referrer, `the specification references more than ${this.limits.maxFiles} files, which is the limit`);
    }
    const read = this.source.read(path, this.limits.maxFileBytes);
    switch (read.status) {
      case 'missing':
        return this.fail(referrer, `"${path}" was not found in ${this.source.origin}`);
      case 'symlink':
        return this.fail(referrer, `"${path}" is, or passes through, a symbolic link, and symbolic links are never followed`);
      case 'not-file':
        return this.fail(referrer, `"${path}" is not a regular file`);
      case 'too-large':
        return this.fail(referrer, `"${path}" is larger than the ${read.limit} byte limit for a referenced file`);
      case 'unreadable':
        return this.fail(referrer, `"${path}" could not be read (${read.detail})`);
      case 'ok':
        break;
    }
    const bytes = Buffer.byteLength(read.text, 'utf8');
    this.totalBytes += bytes;
    if (bytes > this.limits.maxFileBytes) {
      this.fail(referrer, `"${path}" is larger than the ${this.limits.maxFileBytes} byte limit for a referenced file`);
    }
    if (this.totalBytes > this.limits.maxTotalBytes) {
      this.fail(referrer, `the referenced files together exceed the ${this.limits.maxTotalBytes} byte limit`);
    }
    let data: unknown;
    try {
      data = parse(read.text, { uniqueKeys: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
      return this.fail(referrer, `"${path}" is not valid YAML or JSON (${detail})`);
    }
    if (data === null || typeof data !== 'object') {
      return this.fail(referrer, `"${path}" must contain an object or an array`);
    }
    this.parsed.set(path, { data });
    return data;
  }

  /** Rewrites every reference in one file so it points into the folded document. */
  private rewriteFile(file: string, data: unknown): unknown {
    return this.rewrite(file, data, 'node', 0, []);
  }

  private rewrite(file: string, value: unknown, mode: 'node' | 'names', depth: number, path: string[]): unknown {
    this.spend(file);
    if (value === null || typeof value !== 'object') return value;
    if (depth > this.limits.maxDepth) {
      throw new DocumentLoadError(`${file} is nested more than ${this.limits.maxDepth} levels deep (at ${pointerOf(path)}).`);
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => this.rewrite(file, item, 'node', depth + 1, [...path, String(index)]));
    }
    const out: JsonObject = {};
    const source = value as JsonObject;
    for (const key of Object.keys(source)) {
      const entry = source[key];
      const here = [...path, key];
      if (mode === 'names') {
        setOwn(out, key, this.rewrite(file, entry, 'node', depth + 1, here));
      } else if (key === '$ref' && typeof entry === 'string') {
        setOwn(out, key, this.rewriteReference(file, entry, path));
      } else if (key.startsWith('x-') || DATA_KEYS.has(key)) {
        setOwn(out, key, entry);
      } else if (key === 'examples') {
        setOwn(out, key, isObject(entry) ? this.rewrite(file, entry, 'names', depth + 1, here) : entry);
      } else if (NAME_MAP_KEYS.has(key) && isObject(entry)) {
        setOwn(out, key, this.rewrite(file, entry, 'names', depth + 1, here));
      } else {
        setOwn(out, key, this.rewrite(file, entry, 'node', depth + 1, here));
      }
    }
    return out;
  }

  private foldedPointer(file: string, tokens: readonly string[]): string {
    if (file === this.rootPath) return pointerOf(tokens);
    return pointerOf([EXTERNAL_FILES_KEY, file, ...tokens]);
  }

  private rewriteReference(file: string, ref: string, path: string[]): string {
    const where = `${pointerOf(path)}/$ref`;
    const context = { ref, from: file, where };
    const isRoot = file === this.rootPath;

    // A root document keeps its own internal references byte for byte, so a
    // single-file specification behaves exactly as before.
    if (isRoot && ref.startsWith('#')) {
      if (ref.startsWith('#/')) this.chainStarts.add(ref);
      return ref;
    }

    let parsed: ParsedReference;
    try {
      parsed = parseReference(ref);
    } catch (error) {
      return this.fail(context, error instanceof Error ? error.message : String(error));
    }

    let target = file;
    if (parsed.file !== '') {
      const normalized = normalizePath(`${directoryOf(file)}/${parsed.file}`);
      if (normalized === null) {
        return this.fail(context, `the path resolves outside ${this.source.boundary}`);
      }
      if (normalized === '' || parsed.file.endsWith('/')) return this.fail(context, 'the path does not name a file');
      if (normalized.split('/').includes('.git')) return this.fail(context, 'paths inside ".git" are not readable');
      if (!hasSupportedExtension(normalized)) {
        return this.fail(context,
          `"${normalized}" is not a supported file type; only ${SUPPORTED_EXTENSIONS.join(', ')} files can be referenced`);
      }
      target = normalized;
      this.externalReferences++;
    }

    if (target === this.rootPath && parsed.tokens.length === 0) {
      return this.fail(context, 'a reference to the whole root document is not supported');
    }
    if (target !== this.rootPath && !this.parsed.has(target) && !this.firstReferrer.has(target)) {
      this.firstReferrer.set(target, { file: target, tokens: parsed.tokens, ...context });
      this.queue.push(target);
    }
    // The root and files already seen are validated with everything else after
    // loading, so a pointer into a file that is still being read is checked too.
    this.pending.push({ file: target, tokens: parsed.tokens, ...context });

    const rewritten = this.foldedPointer(target, parsed.tokens);
    this.chainStarts.add(rewritten);
    return rewritten;
  }

  private validateTargets(): void {
    for (const pending of this.pending) {
      const loaded = this.parsed.get(pending.file);
      if (!loaded) continue;
      let current: unknown = loaded.data;
      for (const token of pending.tokens) {
        current = childOf(current, token);
        if (current === undefined) {
          this.fail(pending, `the pointer ${pointerOf(pending.tokens)} does not exist in ${pending.file}`);
        }
      }
      if (!isObject(current)) {
        this.fail(pending, `the pointer ${pointerOf(pending.tokens)} in ${pending.file} does not point to an object`);
      }
    }
  }

  /**
   * A reference whose target is itself nothing but a reference can loop without
   * ever reaching a schema. That is a malformed document, reported here rather
   * than left to fail somewhere inside a comparison.
   */
  private rejectAliasCycles(bundle: JsonObject): void {
    const settled = new Set<string>();
    for (const start of this.chainStarts) {
      const chain: string[] = [];
      const seen = new Set<string>();
      let current: string | null = start;
      while (current !== null && !settled.has(current)) {
        if (seen.has(current)) {
          throw new DocumentLoadError(
            `Circular $ref chain that never reaches a definition: ${[...chain, current].map(label).join(' -> ')}.`);
        }
        seen.add(current);
        chain.push(current);
        current = nextAlias(bundle, current);
      }
      for (const entry of chain) settled.add(entry);
    }
  }
}

function pointerTokens(ref: string): string[] {
  return ref.slice(2).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** The reference a node consists of, when that node is a plain `$ref` to an internal pointer. */
function nextAlias(bundle: JsonObject, ref: string): string | null {
  if (!ref.startsWith('#/')) return null;
  let node: unknown = bundle;
  for (const token of pointerTokens(ref)) {
    node = childOf(node, token);
    if (node === undefined) return null;
  }
  if (isObject(node) && typeof node.$ref === 'string' && node.$ref.startsWith('#/')) return node.$ref;
  return null;
}

/** A folded pointer shown as the file and pointer the author wrote. */
function label(ref: string): string {
  const prefix = `#/${EXTERNAL_FILES_KEY}/`;
  if (!ref.startsWith(prefix)) return ref;
  const [file, ...rest] = pointerTokens(ref).slice(1);
  return rest.length === 0 ? file : `${file}${pointerOf(rest)}`;
}

/**
 * Folds every file a specification references into one self-contained document.
 *
 * Returns `root` itself when it references no other file, so a single-file
 * specification is untouched. `rootPath` is the document's path inside the
 * source's boundary.
 */
export function foldReferences(
  root: JsonObject,
  rootPath: string,
  source: DocumentSource,
  limits: ReferenceLimits = DEFAULT_REFERENCE_LIMITS,
): JsonObject {
  const normalized = normalizePath(rootPath);
  if (normalized === null || normalized === '') {
    throw new DocumentLoadError(`The specification path "${rootPath}" is outside ${source.boundary}.`);
  }
  const folded = new Loader(normalized, root, source, limits).run();
  return folded ?? root;
}
