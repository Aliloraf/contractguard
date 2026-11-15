import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { compareSpecifications } from './comparator';
import { loadSpecification } from './load';
import { DocumentLoadError } from './references';
import { renderMarkdown } from './report';
import type { JsonObject } from './types';
import { createDirectorySource } from './workspace';

const USAGE = 'Usage: npm run cli -- --base old-api.yaml --head new-api.yaml '
  + '[--base-root dir] [--head-root dir] [--report report.md]';

function getArg(flag: string): string | undefined {
  const position = process.argv.indexOf(flag);
  return position === -1 ? undefined : process.argv[position + 1];
}

/**
 * Loads one side of the comparison. Files it references are read from the
 * directory tree under `rootDirectory`, which defaults to the document's own
 * directory, and nothing outside that tree is ever read.
 */
function loadSide(documentPath: string, rootDirectory: string | undefined, label: string): JsonObject {
  const absolute = resolve(documentPath);
  const boundary = resolve(rootDirectory ?? dirname(absolute));
  const inside = relative(boundary, absolute);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new DocumentLoadError(`The ${label} document "${documentPath}" is not inside its root directory "${boundary}".`);
  }
  const source = createDirectorySource(boundary, `the directory "${boundary}"`, `the ${label} directory`);
  try {
    return loadSpecification(readFileSync(absolute, 'utf8'), { path: inside.split(sep).join('/'), source });
  } catch (error) {
    if (error instanceof DocumentLoadError) {
      throw new DocumentLoadError(`The ${label} specification "${documentPath}" could not be loaded: ${error.message}`);
    }
    throw error;
  }
}

function main(): void {
  const base = getArg('--base');
  const head = getArg('--head');
  if (!base || !head) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  try {
    const oldSpec = loadSide(base, getArg('--base-root'), 'base');
    const newSpec = loadSide(head, getArg('--head-root'), 'head');
    const result = compareSpecifications(oldSpec, newSpec);
    const report = renderMarkdown(result);
    console.log(report);
    const reportFile = getArg('--report');
    if (reportFile) writeFileSync(reportFile, report);
    if (result.breaking.length) process.exitCode = 1;
  } catch (error) {
    if (error instanceof DocumentLoadError) console.error(`Error: ${error.message}`);
    else console.error(error);
    process.exitCode = 2;
  }
}

main();
