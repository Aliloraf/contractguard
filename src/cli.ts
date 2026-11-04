import { readFileSync, writeFileSync } from 'node:fs';
import { compareSpecifications } from './comparator';
import { loadSpecification } from './load';
import { renderMarkdown } from './report';

function getArg(flag: string): string | undefined {
  const position = process.argv.indexOf(flag);
  return position === -1 ? undefined : process.argv[position + 1];
}

async function main(): Promise<void> {
  const base = getArg('--base');
  const head = getArg('--head');
  if (!base || !head) {
    console.error('Usage: npm run cli -- --base old-api.yaml --head new-api.yaml [--report report.md]');
    process.exitCode = 2;
    return;
  }
  try {
    const oldSpec = loadSpecification(readFileSync(base, 'utf8'));
    const newSpec = loadSpecification(readFileSync(head, 'utf8'));
    const result = compareSpecifications(oldSpec, newSpec);
    const report = renderMarkdown(result);
    console.log(report);
    const reportFile = getArg('--report');
    if (reportFile) writeFileSync(reportFile, report);
    if (result.breaking.length) process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 2;
  }
}

void main();
