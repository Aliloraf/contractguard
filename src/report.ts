import type { ComparisonResult, Finding } from './types';

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function table(findings: Finding[], changeHeading: string): string[] {
  const lines = [`| Rule | Location | ${changeHeading} |`, '| --- | --- | --- |'];
  for (const f of findings) {
    lines.push(`| \`${escapeCell(f.code)}\` | \`${escapeCell(f.location)}\` | ${escapeCell(f.message)} |`);
  }
  return lines;
}

export function renderMarkdown(result: ComparisonResult): string {
  const lines = [
    '<!-- contractguard-report -->',
    '# ContractGuard API compatibility report',
    '',
    `Checked **${result.checkedOperations}** previously documented operations.`,
    '',
  ];
  if (!result.breaking.length) {
    lines.push('✅ No breaking changes detected by the current rule set.');
  } else {
    lines.push(`❌ Found **${result.breaking.length}** potentially breaking changes.`, '',
      ...table(result.breaking, 'Change'));
  }
  if (result.notices.length) {
    lines.push('',
      `⚠️ **${result.notices.length}** place(s) could not be evaluated and need a manual review.`, '',
      ...table(result.notices, 'Not evaluated'));
  }
  lines.push('', '> ContractGuard uses a deliberately limited rule set; a passing report is not a guarantee of full backward compatibility.', '');
  return lines.join('\n');
}
