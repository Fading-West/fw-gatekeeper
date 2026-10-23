# Portal session expiration

Portal authorization checks the Convex Auth session document referenced by the
JWT. Sign-out deletes that document immediately, which invalidates queries that
read it even when a previously issued JWT has not yet expired.

Advancing wall-clock time does not itself invalidate a Convex query cache or
subscription. The `expire portal sessions` cron therefore runs each minute and
deletes sessions whose `expirationTime` has elapsed. Deletion changes the query's
database dependency, so clients no longer retain authorization from a cached
result until the JWT expires. Ordinary requests and mutations also continue to
check the expiration time directly.

This is bounded periodic cleanup, not an exact-deadline timer: an otherwise idle
subscription can retain its previous result until the next one-minute sweep,
plus scheduler latency. Sign-out and account revocation remain immediate database
changes. The scheduler may be delayed; it is not a real-time security deadline.

The cleanup adds `authSessions.by_expirationTime` while retaining every Convex
Auth field and built-in index. Each transaction deletes at most 100 expired
sessions and schedules a continuation when its batch is full. Each deleted
session's refresh tokens are removed in separate batches of 100. Retries are
idempotent, and cleanup refuses to remove tokens belonging to an existing session.
Live sessions and their tokens are untouched.

Deploy the schema, functions and cron together through the normal Convex deploy.
Existing sessions need no backfill; the expiration index covers them as soon as
the schema is active. This code has been checked with synthetic sessions; no
production session was changed during validation.
