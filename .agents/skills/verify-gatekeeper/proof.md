# Pilot proof (Nov 1, 2026)

Candidate `38c49f3b01d6945724e341e5d6d821639ce94be7`, which is `master` `6d7110fd`
plus this package after Sol audit round 1 fixes. The commit that adds this file
changes only `proof.md`. Run `gkv-20261101t202410z-6342ba` under
`~/.cache/fw-gatekeeper-verify/runs/`, with caller canaries exported throughout
(`FWV_CALLER_CANARY`, and `CONVEX_DEPLOYMENT=prod:verify-canary-not-a-real-deployment`).
The canaries were ignored: no child process or deploy picked them up. Backend binary
`precompiled-2026-10-22-1447815` (sha256 `044eedfe569b1550…`), Next build ID
`pcmOO8FHJpYfhnT-yHm-P`, Chromium r1248.

| Command | Result |
| --- | --- |
| `run.mjs prepare` | exit 0, about 35 s: archive, `npm ci`, owned backend + deploy, seed, three role sign-ins via `/login`, `next build` + `next start` |
| `run.mjs doctor --run RUN` | exit 0, 22/22 assertions (`evidence/doctor-20261101T202446Z.json`); `browser-env-isolated`: 6 browser variables, 0 of 60 caller-only variables |
| `run.mjs feature --run RUN` | exit 0, 20/20 assertions (`evidence/feature-20261101T202446Z/`) |
| `run.mjs negative-control --run RUN` | exit 0 (`evidence/negative-control-20261101T202604Z.json`) |
| `run.mjs doctor --run RUN` | exit 0, 22/22 after the control; deployed function hashes equal prepare's |
| `run.mjs cleanup --run RUN` (twice) | exit 0. Both owned processes stopped, `app/ backend/ home/ sessions/` removed, secrets emptied, evidence and logs kept. The second run is a no-op. |

## Feature evidence

- The enrollment user saved a 06:00 clock-in for Tommy Krueger on 2026-10-31
  (row `jh7fqzggaprswywc2xddkt32s98hcpwk`)
  through the dialog: POST 201, and the row showed after save. A fresh read found
  exactly one `attendanceCorrections` row with the UI `request_id`, `add_clock_in` /
  `clock_in` and `actorUserId` set to the enrollment user. The row was still there
  after reload and in a fresh admin session.
- The viewer saw the row but had no **Add missing punch** control
  (`viewer-log.png`). The viewer's replay got 401 `Unauthorized`, and anonymous got
  401. Called directly on Convex, viewer got `Insufficient permissions` and anonymous
  got `Unauthorized`.
- The whole-database diff contained only the one added `attendanceCorrections` row.
  The background changes were limited to `authRefreshTokens`, and no denied nonce
  persisted. The browser blocked no external origins.
- The existing browser proofs (`direct-corrections.browser.test.ts`,
  `AttendanceCorrectionDialog.browser.test.ts`) ran unchanged: 6 passed, 0 failed,
  0 skipped.

## Negative control

The defect (viewer added to `attendanceCorrections.create`) changed only the
`attendanceCorrections.js` deployed module. The same check failed at
`viewer-convex-mutation-denied`, `only-allowed-row-persisted` and
`no-denied-attempt-persisted`, because Convex accepted the viewer and persisted the
row. The Next proxy still returned 401, which is why the direct Convex assertion
matters. After the byte-for-byte restore and redeploy, the function hashes equaled
prepare's and the check passed.

## Sol audit round 1 (`c35c71e8`, REQUEST_CHANGES), fixed

- The snapshot canonicalizer passed a top-level key whitelist to
  `JSON.stringify`, which dropped nested fields, so nested writes were invisible
  to the whole-database diff. It now uses a recursive `canonicalJson`.
- Chromium inherited the caller's `process.env`. It, `keygen` and host tools now
  get explicit environments. Doctor's `browser-env-isolated` assertion launches
  Chromium through a wrapper that records variable names, because Chromium
  rewrites its own `/proc/<pid>/environ` and a /proc-based check passed vacuously.
  Red check: with the explicit env removed, it failed listing 59 leaked names.

## Development failures found by the package (fixed before this proof)

- Playwright `response.json()` on the save response never resolved in headless
  Chromium, so the receipt is now taken from the fresh database read.
- Convex Auth refresh-token rotation made saved sessions stale. Sessions are now
  saved when a role's context closes, and `openRole` waits for the client's token
  refresh before deciding whether to sign in again.
- A repeated attempt in the same run tripped the dialog's two-minute duplicate
  guard. Each attempt now uses its own time slot.

## Limitations

Covered only by this local pass: none of the kiosk hardware, ingest, face service,
alert delivery, the real Command Center consumer, Render or the production Convex
deployment was exercised. `convex-local-backend` is the cached self-hosted binary,
not Convex Cloud. Fixture accounts are inserted directly because no first-admin
bootstrap exists.
