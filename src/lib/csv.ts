/** Encode one spreadsheet-safe CSV cell without changing stored source data. */
export function csvField(value: unknown): string {
  let text = String(value ?? '');
  // CSV quoting protects column boundaries, but does not stop spreadsheets
  // interpreting names or notes as formulas. Preserve leading whitespace
  // behind the text marker as some importers skip it before looking for '='.
  if (typeof value === 'string' && (/^\s*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))) {
    text = `'${text}`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
