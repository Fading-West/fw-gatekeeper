import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import { knownApiErrorResponse, logApiError } from './api-errors';

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

it.each([
  'Worker not found',
  '[Request ID: aabbccdd11223344] Server Error\nUncaught Error: Worker not found\n    at handler (convex/workers.ts:427:24)\n',
  '[Request ID: aabbccdd11223344] Server Error\r\nUncaught Error: Worker not found\r\n    at handler (convex/workers.ts:427:24)\r\n',
])('recognizes plain legacy text and LF/CRLF HTTP envelopes: %s', async message => {
  const response = knownApiErrorResponse(new Error(message), { 'Worker not found': 400 });
  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({ error: 'Worker not found' });
});

it.each([
  'private payload\n[Request ID: aabbccdd11223344] Server Error\nUncaught Error: Worker not found',
  '[Request ID: aabbccdd11223344] Server Error\nprivate payload\nUncaught Error: Worker not found',
  '[Request ID: aabbccdd11223344] Server Error\nUncaught Error: Worker not found PRIVATE',
])('does not unwrap validation text outside the leading envelope: %s', message => {
  expect(knownApiErrorResponse(new Error(message), { 'Worker not found': 400 })).toBeNull();
});

it('keeps fetch failure locations and a network cause code without message, host or credentials', () => {
  const error = new TypeError('fetch failed PRIVATE', { cause: Object.assign(new Error('PRIVATE host'), { code: 'ECONNREFUSED', address: 'PRIVATE address' }) });
  error.stack = `${error.name}: ${error.message}\n    at PRIVATE (/opt/render/project/src/.next/server/chunks/[root-of-the-server]__abc._.js:1:1234)\n    at node:internal/deps/undici/undici:13510:13\n    at fetch (https://PRIVATE:SECRET@example.test/route.js:1:2)\n`;
  logApiError('Face encoding failed:', error);
  expect(console.error).toHaveBeenCalledWith('Face encoding failed:', {
    type: 'TypeError', networkCode: 'ECONNREFUSED',
    frames: ['/opt/render/project/src/.next/server/chunks/[root-of-the-server]__abc._.js:1:1234', 'node:internal/deps/undici/undici:13510:13'],
  });
});

it.each(['SyntaxError', 'ReferenceError', 'AbortError', 'TimeoutError'])('distinguishes %s without retaining its payload', name => {
  const error = Object.assign(new Error('PRIVATE photo data'), { name });
  error.stack = `${name}: ${error.message}\n    at POST (/app/src/app/api/enroll/route.ts:130:42)`;
  logApiError('Failure:', error);
  expect(console.error).toHaveBeenCalledWith('Failure:', { type: name, frames: ['/app/src/app/api/enroll/route.ts:130:42'] });
});

it.each([
  new Error('[Request ID: aabbccdd11223344] Server Error\nArgumentValidationError: PRIVATE\n    at payload (PRIVATE.ts:1:2)'),
  new ConvexError({ photos: ['PRIVATE'], faceEncoding: Array(512).fill(0.987654321) }),
])('removes the entire Convex message, including payloads imitating stack frames', error => {
  error.stack = `${error.name}: ${error.message}\n    at client (/app/node_modules/convex/dist/http_client.js:499:15)`;
  error.cause = { code: 'ECONNREFUSED', secret: 'PRIVATE' };
  logApiError('Backend failed:', error);
  expect(console.error).toHaveBeenCalledWith('Backend failed:', expect.objectContaining({ frames: ['/app/node_modules/convex/dist/http_client.js:499:15'] }));
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/PRIVATE|faceEncoding|0\.987654321|ArgumentValidationError/);
});

it('bounds frame output and ignores arbitrary error names and cause codes', () => {
  const error = Object.assign(new Error('PRIVATE'), { name: 'PRIVATE name', cause: { code: 'PRIVATE code' } });
  error.stack = `${error.name}: ${error.message}\n${Array(50).fill('    at handler (/app/src/lib/convex.ts:1:2)').join('\n')}`;
  logApiError('Failure:', error);
  expect(console.error).toHaveBeenCalledWith('Failure:', { type: 'Error', frames: Array(8).fill('/app/src/lib/convex.ts:1:2') });
});
