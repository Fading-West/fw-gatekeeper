import { ConvexError } from 'convex/values';
import { NextResponse } from 'next/server';

// Legacy mutations throw ordinary Errors. Expose only allowlisted validation
// text, never the surrounding Convex request ID, function name, or stack.
export function knownApiErrorResponse(
  error: unknown,
  messages: Readonly<Record<string, 400 | 409>>,
  conflicts: readonly RegExp[] = [],
) {
  const data = error instanceof ConvexError ? error.data : undefined;
  const raw = error instanceof ConvexError
    ? typeof data === 'string' ? data : typeof data?.message === 'string' ? data.message : ''
    : error instanceof Error ? error.message : '';
  // Only unwrap the leading Convex HTTP diagnostic envelope. A validation
  // phrase embedded in an unrelated error (or its payload) is not safe.
  const message = raw.match(/^\[Request ID: [a-zA-Z0-9_-]{1,128}\] Server Error\r?\nUncaught Error: ([^\r\n]+)(?:\r?\n|$)/)?.[1] ?? raw;
  if (Object.hasOwn(messages, message)) {
    return NextResponse.json({ error: message }, { status: messages[message] });
  }
  if (conflicts.some(pattern => pattern.test(message))) {
    return NextResponse.json({ error: message }, { status: 409 });
  }
  return null;
}

const errorTypes = new Set(['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'URIError', 'EvalError', 'AbortError', 'TimeoutError']);
const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

function errorFrames(error: Error) {
  // Remove the entire message first: multiline payloads can imitate stack frames.
  const header = `${error.name}: ${error.message}`;
  const stack = error.stack;
  if (!stack?.startsWith(`${header}\n`)) return [];
  return stack.slice(header.length + 1, header.length + 8193).split('\n').flatMap(line => {
    // File/line locations only; discard function names, URLs, queries and eval.
    const location = line.match(/^\s+at (?:[^()\r\n]+ \()?((?:[./\w@\[\]-]+\.(?:[cm]?js|tsx?)|node:[\w/-]+):\d{1,10}:\d{1,10})\)?$/)?.[1];
    return location && location.length <= 256 ? [location] : [];
  }).slice(0, 8);
}

// Convex validation errors can print face templates and photo bytes. Keep all
// messages/data private; bounded types, source locations and network codes let
// operators diagnose local failures without access to the Convex dashboard.
export function logApiError(context: string, error: unknown) {
  const requestId = error instanceof Error
    ? error.message.match(/^\[Request ID: ([a-fA-F0-9]{16,32})\] Server Error(?:\r?\n|$)/)?.[1]
    : undefined;
  const frames = error instanceof Error ? errorFrames(error) : [];
  const cause = error instanceof Error && !(error instanceof ConvexError) ? error.cause : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  console.error(context, {
    type: error instanceof ConvexError ? 'ConvexError' : error instanceof Error ? errorTypes.has(error.name) ? error.name : 'Error' : 'Unknown',
    ...(requestId ? { requestId } : {}),
    ...(frames.length ? { frames } : {}),
    ...(typeof code === 'string' && networkCodes.has(code) ? { networkCode: code } : {}),
  });
}
