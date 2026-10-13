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
  const raw = typeof data === 'string' ? data : typeof data?.message === 'string' ? data.message : error instanceof Error ? error.message : '';
  const message = raw.match(/^Uncaught Error: ([^\r\n]+)\r?$/m)?.[1] ?? raw;
  if (Object.hasOwn(messages, message)) {
    return NextResponse.json({ error: message }, { status: messages[message] });
  }
  if (conflicts.some(pattern => pattern.test(message))) {
    return NextResponse.json({ error: message }, { status: 409 });
  }
  return null;
}
