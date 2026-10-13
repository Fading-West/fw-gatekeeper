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

// Convex validation errors can print argument values, including face templates
// and photo bytes. Never log arbitrary messages, stacks, data, or error fields.
// A bounded hex request ID still lets operators correlate with Convex logs.
export function logApiError(context: string, error: unknown) {
  const requestId = error instanceof Error
    ? error.message.match(/^\[Request ID: ([a-fA-F0-9]{16,32})\] Server Error(?:\r?\n|$)/)?.[1]
    : undefined;
  console.error(context, {
    type: error instanceof ConvexError ? 'ConvexError' : error instanceof Error ? 'Error' : 'Unknown',
    ...(requestId ? { requestId } : {}),
  });
}
