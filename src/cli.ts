import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { compareSpecifications } from './comparator';
import { loadSpecification } from './load';
import { DocumentLoadError } from './references';
import { renderMarkdown } from './report';
import { REPORT_FORMATS, isReportFormat, renderReport } from './report-format';
import type { ReportFormat } from './report-format';
import type { JsonObject } from './types';
import { createDirectorySource } from './workspace';

const USAGE = 'Usage: npm run cli -- --base old-api.yaml --head new-api.yaml '
  + '[--base-root dir] [--head-root dir] [--format markdown|json|sarif] [--output file] [--report report.md]';

/** A usage mistake, reported on stderr with exit code 2 before any work is done. */
class UsageError extends Error {}

function getArg(flag: string): string | undefined {
  const position = process.argv.indexOf(flag);
  return position === -1 ? undefined : process.argv[position + 1];
}

/** The value of a flag that must have one: absent is `undefined`, a missing value is an error. */
function requiredValue(flag: string): string | undefined {
  const position = process.argv.indexOf(flag);
  if (position === -1) return undefined;
  const value = process.argv[position + 1];
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw new UsageError(`${flag} needs a value.`);
  }
  return value;
}

function readFormat(): ReportFormat {
  const value = requiredValue('--format');
  if (value === undefined) return 'markdown';
  if (!isReportFormat(value)) {
    throw new UsageError(`Unsupported --format "${value}". Use one of: ${REPORT_FORMATS.join(', ')}.`);
  }
  return value;
}

function sameFile(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * Checks an output file before the comparison runs, so a bad path fails fast and
 * never after the report was produced. The output may not overwrite one of the
 * documents being compared.
 */
function checkOutputPath(flag: string, output: string, inputs: string[]): void {
  const target = resolve(output);
  const parent = dirname(target);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new UsageError(`${flag}: the directory "${parent}" does not exist.`);
  }
  if (existsSync(target) && statSync(target).isDirectory()) {
    throw new UsageError(`${flag}: "${output}" is a directory, not a file.`);
  }
  for (const input of inputs) {
    if (sameFile(target, input)) throw new UsageError(`${flag}: "${output}" is one of the compared specifications and would be overwritten.`);
  }
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
    const format = readFormat();
    const output = requiredValue('--output');
    if (output !== undefined) checkOutputPath('--output', output, [base, head]);

    const oldSpec = loadSide(base, getArg('--base-root'), 'base');
    const newSpec = loadSide(head, getArg('--head-root'), 'head');
    const result = compareSpecifications(oldSpec, newSpec);
    const report = renderMarkdown(result);
    const rendered = format === 'markdown'
      ? report
      : renderReport(format, result, { baseline: { path: base, revision: null }, head: { path: head, revision: null } });

    // Only the report goes to stdout, so JSON and SARIF can be piped as they are.
    // With --output it goes to the file instead and stdout stays empty.
    if (output !== undefined) writeFileSync(output, rendered);
    else if (format === 'markdown') console.log(rendered);
    else process.stdout.write(rendered);

    const reportFile = getArg('--report');
    if (reportFile) writeFileSync(reportFile, report);
    if (result.breaking.length) process.exitCode = 1;
  } catch (error) {
    if (error instanceof UsageError) console.error(`Error: ${error.message}\n${USAGE}`);
    else if (error instanceof DocumentLoadError) console.error(`Error: ${error.message}`);
    else console.error(error);
    process.exitCode = 2;
  }
}

main();
