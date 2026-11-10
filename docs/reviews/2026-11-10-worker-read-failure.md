# Worker inventory after a failed read

Base: `origin/master` at `8c6c8ba4446cf7cfef2d4cac2a520da299d43e7b`.
Trello: https://trello.com/c/gAbK480n.

A failed `/api/workers` read becomes `data=null` in `useSelectedData`, which the
page defaults to an empty array. The error banner previously appeared alongside
zero registered/inactive workers, zero retained face data, and “No workers match
these filters.” An operator reviewing biometric retention could mistake an
unavailable inventory for no remaining face data.

The page now shows “Worker counts unavailable”, hides inventory summaries and
empty/filter results until a read succeeds, and offers “Retry loading workers”.
Initial loading also withholds counts. A successful empty response still shows
zero workers and the genuine empty-roster message.

## Reproduction and proof

Run `node node_modules/vitest/vitest.mjs run src/app/workers/read-failure.test.tsx
--maxWorkers=1`. Before the product change, two failure cases fail and the empty
roster control passes. Afterward all three pass, including retry recovery into a
nonempty active/inactive roster. All five worker-page test files pass (12 tests).
The adjacent evidence directory preserves red and green transcripts.

Phone (390×844) and desktop (1280×800) before/after PNGs are in that directory and
`~/t3-ui-proof/gAbK480n/workers/`. They render the real page component, hook and
Tailwind styles with an admin-role fixture and intercepted HTTP 503 roster
responses (the kiosk endpoint returns a successful empty list). They are
component proof, not a running Convex backend, production outage, or hardware
pilot. External Google Fonts are omitted; system font fallback is used.

The earlier November 7 card mentioned this symptom as an unimplemented lower
priority observation. No open PR owns `src/app/workers/page.tsx`; existing worker
selection, inactive readiness, edit errors and editor recovery tests stay intact.
No backend, identity, purge operation or shared selection-hook behavior changes.

## Post-merge duty

After Noah merges this PR, the owner removes this worktree and settles the T3
thread. Leave the PR open for human review; no merge or deployment is authorized.
