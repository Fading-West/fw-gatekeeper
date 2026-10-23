#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildConservativeFactoryLocalTimestampRanges,
  getFactoryLocalDateKey,
  getFactoryLocalTimestamp,
  getNextFactoryLocalDateKey,
  getPreviousFactoryLocalDateKey,
  isValidFactoryLocalDateKey,
  timestampBelongsToFactoryLocalDate,
} from '../convex/localDate.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const central = { utcOffsetMinutes: -300 };

assert.equal(isValidFactoryLocalDateKey('2026-06-26'), true);
assert.equal(isValidFactoryLocalDateKey('2024-02-29'), true);
assert.equal(isValidFactoryLocalDateKey('2026-02-29'), false);
assert.equal(isValidFactoryLocalDateKey('2026-6-26'), false);
assert.equal(isValidFactoryLocalDateKey('2026-13-01'), false);

assert.equal(getPreviousFactoryLocalDateKey('2026-06-26'), '2026-06-25');
assert.equal(getNextFactoryLocalDateKey('2026-06-26'), '2026-06-27');
assert.equal(getNextFactoryLocalDateKey('2024-02-28'), '2024-02-29');
assert.equal(getNextFactoryLocalDateKey('2026-12-31'), '2027-01-01');

const cases = [
  ['date-only factory prefix', '2026-06-26', '2026-06-26'],
  ['local naive start of day', '2026-06-26T00:00:00', '2026-06-26'],
  ['local naive late evening', '2026-06-26T23:30:00', '2026-06-26'],
  ['local naive after midnight', '2026-06-27T00:30:00', '2026-06-27'],
  ['UTC just before selected local day', '2026-06-26T04:59:59Z', '2026-06-25'],
  ['UTC selected local midnight', '2026-06-26T05:00:00Z', '2026-06-26'],
  ['UTC selected local late evening', '2026-06-27T04:30:00Z', '2026-06-26'],
  ['UTC next local day', '2026-06-27T05:30:00Z', '2026-06-27'],
  ['offset selected local late evening', '2026-06-26T23:30:00-05:00', '2026-06-26'],
  ['offset next local day', '2026-06-27T00:30:00-05:00', '2026-06-27'],
  ['different offset same factory evening', '2026-06-27T00:30:00-04:00', '2026-06-26'],
  ['previous-date offset lands on selected day', '2026-06-25T23:30:00-06:00', '2026-06-26'],
];

for (const [label, timestamp, expectedDate] of cases) {
  assert.equal(getFactoryLocalDateKey(timestamp, central), expectedDate, label);
}

assert.equal(getFactoryLocalDateKey('2026-06-27T04:30:00Z', { timeZone: 'America/Chicago' }), '2026-06-26');
assert.equal(getFactoryLocalDateKey('not-a-timestamp', central), null);
assert.equal(getFactoryLocalDateKey(null, central), null);
assert.equal(getFactoryLocalTimestamp('2026-06-27T04:30:00Z', central), '2026-06-26T23:30:00');
assert.equal(getFactoryLocalTimestamp('2026-06-27T04:30:00Z', { timeZone: 'America/Chicago' }), '2026-06-26T23:30:00');
assert.equal(getFactoryLocalTimestamp('2026-06-26T23:30:00', central), '2026-06-26T23:30:00');

const selectedDate = '2026-06-26';
const selectedDateTimestamps = [
  '2026-06-26',
  '2026-06-26T23:30:00',
  '2026-06-27T04:30:00Z',
  '2026-06-26T23:30:00-05:00',
  '2026-06-27T00:30:00-04:00',
  '2026-06-25T23:30:00-06:00',
];
const otherDateTimestamps = [
  '2026-06-25T23:30:00',
  '2026-06-26T04:59:59Z',
  '2026-06-27T00:30:00-05:00',
  '2026-06-27T05:30:00Z',
];

for (const timestamp of selectedDateTimestamps) {
  assert.equal(
    timestampBelongsToFactoryLocalDate(timestamp, selectedDate, central),
    true,
    `${timestamp} should belong to ${selectedDate}`,
  );
}

for (const timestamp of otherDateTimestamps) {
  assert.equal(
    timestampBelongsToFactoryLocalDate(timestamp, selectedDate, central),
    false,
    `${timestamp} should not belong to ${selectedDate}`,
  );
}

const ranges = buildConservativeFactoryLocalTimestampRanges(selectedDate);
assert.deepEqual(ranges, [{ startTimestamp: '2026-06-25', endTimestamp: '2026-06-28' }]);
for (const timestamp of selectedDateTimestamps) {
  assert.equal(
    ranges.some((range) => timestamp >= range.startTimestamp && timestamp < range.endTimestamp),
    true,
    `${timestamp} should be covered by the conservative query range`,
  );
}
assert.equal(
  ranges.some((range) => '2026-06-25T23:30:00' >= range.startTimestamp && '2026-06-25T23:30:00' < range.endTimestamp),
  true,
  'Conservative ranges may include false positives that callers post-filter by factory local date',
);

assert.throws(() => buildConservativeFactoryLocalTimestampRanges('2026-02-29'), /dateKey must use YYYY-MM-DD format/);
assert.throws(() => timestampBelongsToFactoryLocalDate('2026-06-26', '2026-13-01'), /dateKey must use YYYY-MM-DD format/);

const helper = read('convex/localDate.ts');
assert.doesNotMatch(helper, /from ["']convex\//, 'Local date helper should stay pure and importable from Convex modules.');

const attendance = read('convex/attendance.ts');
assert.match(attendance, /buildConservativeFactoryLocalTimestampRanges/, 'Attendance date reads should use conservative indexed ranges.');
assert.match(attendance, /timestampBelongsToFactoryLocalDate/, 'Attendance date reads should post-filter by factory local date.');
assert.match(attendance, /getFactoryLocalTimestamp/, 'Attendance date reads should normalize absolute timestamps to factory local time before schedule checks.');
assert.doesNotMatch(attendance, /gte\("timestamp", start\)\.lt\("timestamp", end\)/, 'Attendance date reads should not use a narrow string-prefix day range.');
assert.match(attendance, /new Map<string, any>\(\)/, 'Attendance date reads should dedupe overlapping conservative ranges.');

const recognitionAttempts = read('convex/recognitionAttempts.ts');
assert.match(recognitionAttempts, /listRecognitionAttemptsByFactoryDate/, 'Recognition attempts should expose a reusable factory-date reader.');
assert.match(recognitionAttempts, /listAllRecognitionAttemptsByFactoryDate/, 'Recognition attempts should expose an uncapped factory-date reader for closeout blockers.');
assert.match(recognitionAttempts, /buildConservativeFactoryLocalTimestampRanges/, 'Recognition attempts should use conservative indexed ranges for date reads.');
assert.match(recognitionAttempts, /timestampBelongsToFactoryLocalDate/, 'Recognition attempts should post-filter by factory local date.');
assert.match(recognitionAttempts, /applyLimit:\s*false/, 'Recognition attempts should filter the widened factory-date range before applying the requested limit.');
assert.doesNotMatch(recognitionAttempts, /conservativeLimit/, 'Recognition attempts should not pre-limit adjacent-day rows before factory-date filtering.');
assert.match(recognitionAttempts, /selectRecognitionAttemptsByFactoryDate\(ctx,\s*\{[\s\S]*date/, 'listByDate should use the bounded factory-date selection reader.');

const shiftExceptions = read('convex/shiftExceptions.ts');
assert.match(shiftExceptions, /listAllRecognitionAttemptsByFactoryDate\(ctx,\s*\{\s*date\s*\}\)/, 'Shift exceptions should use the uncapped recognition factory-date reader.');
assert.doesNotMatch(shiftExceptions, /limit:\s*1000/, 'Shift exceptions should not cap recognition blockers before closeout.');
assert.doesNotMatch(shiftExceptions, /recognitionAttempts"\)\s*\.withIndex\("by_timestamp"[\s\S]*gte\("timestamp", date\)/, 'Shift exceptions should not use a narrow recognition timestamp date range.');

const attendanceCorrections = read('convex/attendanceCorrections.ts');
assert.match(attendanceCorrections, /timestampBelongsToFactoryLocalDate/, 'Attendance correction validation should honor factory-local date membership.');
assert.doesNotMatch(attendanceCorrections, /getDateKey\(original\.timestamp\) !== args\.date/, 'Void corrections should not validate original events by raw timestamp prefix.');
assert.doesNotMatch(attendanceCorrections, /getDateKey\(args\.correctedTimestamp\) !== args\.date/, 'Added corrections should not validate corrected timestamps by raw timestamp prefix.');

const packageJson = read('package.json');
assert.match(packageJson, /"test:convex-local-date":\s*"node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts\/test-convex-local-date-contract\.mjs"/, 'package.json must expose test:convex-local-date.');

console.log('Convex local date contract passed');
