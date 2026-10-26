import { expect, it } from 'vitest';
import { parseQueueCount } from './attendance-queue';

it.each([0, 1, 237, Number.MAX_SAFE_INTEGER, '0', '237'])('accepts %j', value => {
  expect(parseQueueCount(value)).toBe(Number(value));
});

it.each([undefined, null, '', ' ', true, false, 1.5, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '01', '-0', '1.0', '1e3', '0x10', ' 5', '5\n', [], {}, '9007199254740992'])('rejects %j', value => {
  expect(parseQueueCount(value)).toBeUndefined();
});
