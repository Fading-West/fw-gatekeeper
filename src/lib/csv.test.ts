import { expect, it } from 'vitest';
import { csvField } from './csv';

it.each(['=1+1', '+SUM(A1:A2)', '-1+2', '@SUM(A1:A2)', '  =1+1', '\t=1+1', '\uFEFF=1+1'])(
  'exports formula-like text as a literal cell: %j', (value) => {
    expect(csvField(value)).toBe(`'${value}`);
  },
);

it.each(['\tWorker', '\r=1+1', '\n=1+1'])(
  'neutralizes leading control characters before CSV escaping: %j', (value) => {
    const escaped = csvField(value);
    expect(escaped.startsWith("'") || escaped.startsWith('"\'')).toBe(true);
    if (/[\r\n]/.test(value)) expect(escaped).toBe(`"'${value}"`);
  },
);

it('quotes formula content containing quotes, commas and newlines as one cell', () => {
  expect(csvField('=HYPERLINK("https://example.invalid", "Link")'))
    .toBe('"\'=HYPERLINK(""https://example.invalid"", ""Link"")"');
  expect(csvField('ordinary\rnote')).toBe('"ordinary\rnote"');
  expect(csvField('Smith, "Alex"\nAssembly')).toBe('"Smith, ""Alex""\nAssembly"');
});

it('preserves ordinary text, timestamps, empty cells and numeric values', () => {
  for (const value of ['Alex', '2026-09-29T08:00:00', '8.00', "O'Brien", '']) {
    expect(csvField(value)).toBe(value);
  }
  expect(csvField(null)).toBe('');
  expect(csvField(undefined)).toBe('');
  expect(csvField(-8)).toBe('-8');
  expect(csvField(8)).toBe('8');
});
