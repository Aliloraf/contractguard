import { renderJson } from './json-report';
import { renderMarkdown } from './report';
import { renderSarif } from './sarif';
import { EMPTY_CONTEXT } from './report-model';
import type { ReportContext } from './report-model';
import type { ComparisonResult } from './types';

export const REPORT_FORMATS = ['markdown', 'json', 'sarif'] as const;
export type ReportFormat = typeof REPORT_FORMATS[number];

export function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

/** Renders a result in the requested format. Markdown ignores the context. */
export function renderReport(format: ReportFormat, result: ComparisonResult, context: ReportContext = EMPTY_CONTEXT): string {
  switch (format) {
    case 'markdown': return renderMarkdown(result);
    case 'json': return renderJson(result, context);
    case 'sarif': return renderSarif(result, context);
  }
}
