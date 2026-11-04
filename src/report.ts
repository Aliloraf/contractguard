import type { ComparisonResult } from './types';

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
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
      '| Rule | Location | Change |', '| --- | --- | --- |');
    for (const f of result.breaking) {
      lines.push(`| \`${escapeCell(f.code)}\` | \`${escapeCell(f.location)}\` | ${escapeCell(f.message)} |`);
    }
  }
  lines.push('', '> ContractGuard v0.1 uses a deliberately limited rule set; a passing report is not a guarantee of full backward compatibility.', '');
  return lines.join('\n');
}
