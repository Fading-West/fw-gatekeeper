# Discovery record (Nov 1, 2026)

Rechecked live against `master` at `6d7110fd`. Trello card: https://trello.com/c/8MdUnguJ.

## Observed

- **Auth**: Convex Auth (`@convex-dev/auth`) with one `ConvexCredentials` provider
  `password` (Lucia Scrypt), sign-up disabled (invite-only), session creation
  requires an active `portalMembers` row (`convex/auth.ts`). Next.js uses
  `convexAuthNextjsMiddleware` in `src/proxy.ts` with httpOnly
  `__convexAuthJWT` / `__convexAuthRefreshToken` cookies. These are non-Secure on
  plain-HTTP loopback, and sign-in works there.
- **Roles**: `admin`, `enrollment`, `viewer` (`convex/schema.ts` `portalMembers.role`).
  They are enforced three times: `src/proxy.ts` `getApiAllowedRoles` (default
  admin-only), each route's `hasValidPortalSession`, and Convex `assertPortalRole`
  (`convex/access.ts`), which also checks the session and `mustChangePassword`.
- **Backend**: Convex only. Production is `modest-bat-146` (README, render.yaml).
  The repository documents no shared dev deployment. A cached
  `convex-local-backend` (`~/.cache/convex/binaries/precompiled-2026-10-22-1447815`)
  runs a private SQLite instance on loopback. `keygen admin-key` derives its admin
  key, and `convex deploy` targets it through `CONVEX_SELF_HOSTED_URL` /
  `CONVEX_SELF_HOSTED_ADMIN_KEY`. Deploy, env vars (`/api/update_environment_variables`),
  `seed:run`, `auth:store` and table reads all worked with no cloud account.
- **Build/start**: `npm ci` (about 6 s with a warm cache), `next build` (about 16 s)
  and `next start -H 127.0.0.1` with `NEXT_PUBLIC_CONVEX_URL` pointed at the owned
  backend. `/api/health` reports `convex: ok`.
- **Tests and browser tooling**: `npm test` = Vitest + Python + `scripts/test-*.mjs`
  contracts. These run Convex in memory (`convex-test`) and use no deployment.
  `playwright-core` 1.64.0 with Chromium revision 1248 is cached in
  `~/.cache/ms-playwright`. Existing browser proofs (`*.browser.test.ts`) bundle a
  page fixture with Vite and drive it in Chromium. Without
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` they skip locally, and with `CI` set they
  fail if the browser cannot launch. The Activity Log ones are
  `src/app/log/direct-corrections.browser.test.ts` and
  `src/components/AttendanceCorrectionDialog.browser.test.ts`.
- **Agent/integration endpoint**: `GET /api/activity` (Command Center feed, bearer
  `ACTIVITY_FW_GATEWAY_TOKEN` bound to an admin `users` id) was exercised with a
  run-owned token: 200 `version: 1`, and 401 without a token.
- **Credentials**: names only. Render and Convex declare `CONVEX_INGEST_KEY`,
  `KIOSK_API_KEY`, `FACE_SERVICE_KEY`, `FACE_ENCODE_URL`, `JWT_PRIVATE_KEY`, `JWKS`,
  `SITE_URL`, `ACTIVITY_FW_GATEWAY_*` and optional `RESEND_API_KEY` / `ALERT_*`
  (`.env.example`). No main-checkout `.env*` was read or needed. This package
  generates its own values and consumes none of the real ones.

## Documented but unproven here

Kiosk (Pi) sync/ingest with device credentials, the face-service encode/match,
Resend/webhook alert and people-alert delivery, the real Command Center consumer,
Render hosting and `npx convex deploy` to production.

## Unknown / blocked

The implementation thread has no Trello writer, so the supervisor relays card
comments. No questions for Noah were needed: every dependency was local and
disposable.

## Pilot choice

Activity Log **Add missing punch** writes an `attendanceCorrections` row with
`actorUserId`. `enrollment` is the least-privileged allowed role, and `viewer` can
read the log but is denied by all three server guards. The same flow has existing
browser proofs to wrap.

## Same-repo ownership at start

There were 28 open PRs (#112 #113 #165 #192 #231-#237 #246-#248 #252 #265 #267-#276
#278-#280). Their changed paths include `convex/**` (including
`convex/attendanceCorrections.ts` in #274), `src/**`, `pi-kiosk/**`,
`face-service/**`, `docs/alerting.md`, `docs/recognition-review-rollout.md`,
`docs/reviews/**`, `scripts/*`, `.github/workflows/ci.yml`, `package.json`,
`package-lock.json` and `RETENTION.md`. The file map is in the supervisor cache
(`~/.cache/gk-verify-nov01/open-pr-files.tsv`). This package changes only
`.agents/skills/verify-gatekeeper/**`, `.claude/skills/verify-gatekeeper/SKILL.md`
and one paragraph in `docs/testing.md`, none of which is touched by an open PR.

## Skill location

`.agents/skills/verify-gatekeeper/` is the repository skill path Codex discovers,
and `agents/openai.yaml` disables implicit invocation. Claude Code discovers
`.claude/skills/` (tracked in this repository, see `.claude/launch.json`), so
`.claude/skills/verify-gatekeeper/SKILL.md` is a pointer with
`disable-model-invocation: true`. The same layout is used by `verify-fwsiteschedule`.
