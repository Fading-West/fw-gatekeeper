# verify-gatekeeper environment reference

## Prerequisites (names and readiness only)

| Need | Where it comes from | Checked by |
| --- | --- | --- |
| Node 22–24 and npm | `PATH` (repo `engines`: `>=22 <25`) | prepare (`npm ci`, `next build`) |
| `git`, `tar`, `ss` (iproute2) | system | prepare, Doctor |
| `convex-local-backend` | newest `~/.cache/convex/binaries/*/convex-local-backend` (left there by any `npx convex dev --local`), or `--backend-bin PATH` | prepare (sha256 recorded), Doctor |
| Chromium for the candidate's `playwright-core` | `~/.cache/ms-playwright/chromium-<rev>` (`npx playwright-core install chromium`), or `PLAYWRIGHT_BROWSERS_PATH` | prepare, Doctor, feature |
| npm registry or warm npm cache | `npm ci` in the archived copy | prepare |

No account, cloud credential or secret is required. Nothing is read from `.env*`,
`~/.convex`, `CONVEX_DEPLOYMENT`, `CONVEX_DEPLOY_KEY` or any caller environment
variable: every child process, including Chromium, gets an explicit environment
and `HOME=RUN/home` (except `npm ci`, which uses the real home for its package
cache, and host tools such as `git`/`tar`/`ss`, which get only `PATH`, `HOME` and
`LANG`). Doctor's `browser-env-isolated` assertion checks the browser processes.

## Options

| Command | Options |
| --- | --- |
| `prepare` | `--repo PATH` (default: current checkout), `--backend-bin PATH`, `--runs-dir DIR` (default `~/.cache/fw-gatekeeper-verify/runs`) |
| `doctor`, `feature`, `negative-control`, `cleanup` | `--run RUN` (required); `doctor` also takes `--repo PATH` |

## Bindings generated per run (all private to `RUN/state.json`, emptied by cleanup)

| Binding | Consumer | Value |
| --- | --- | --- |
| backend instance name / secret, admin key | owned `convex-local-backend`; `convex deploy` via `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY` | random; the instance secret is on the owned backend's command line (same-user visible) and protects only that disposable backend |
| `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL` | Convex Auth on the owned backend | fresh RSA key pair; `SITE_URL` = the run's app URL |
| `CONVEX_INGEST_KEY` | owned backend and app (`CONVEX_INGEST_URL` = owned site port) | random |
| `KIOSK_API_KEY` | app (kiosk routes fail closed without it) | random, unused |
| `ACTIVITY_FW_GATEWAY_TOKEN`, `ACTIVITY_FW_GATEWAY_ACCOUNT_ID` | owned backend; Doctor's `/api/activity` check | random token mapped to the run's admin user |
| `NEXT_PUBLIC_CONVEX_URL` | baked into the run's `next build` | `http://127.0.0.1:<backend port>` |
| portal accounts | `admin@`, `enrollment@`, `viewer@verify-gatekeeper.invalid` | random passwords, `mustChangePassword: false` |

Fixture accounts are created with Convex Auth's own `auth:store`
(`createAccountFromCredentials`, the repository's Scrypt crypto) and a directly
inserted `portalMembers` row, because the repository has no first-admin bootstrap
and `createPortalAccount` itself requires an admin. Workers, schedule, kiosks and
sample attendance come from the repository's `convex/seed.ts` (`seed:run`).

## Run directory

```
RUN/
  state.json        private; secrets emptied by cleanup
  operation.lock    present only while a command runs
  app/              archived candidate + node_modules + .next   (removed by cleanup)
  backend/          SQLite database and file storage             (removed by cleanup)
  home/             HOME for child processes                     (removed by cleanup)
  sessions/         per-role browser cookies (0600)              (removed by cleanup)
  logs/             npm, deploy, build, backend and app logs     (kept, private)
  evidence/         prepare.json, doctor-*.json, feature-*/, negative-*/, negative-control-*.json, cleanup.json (kept)
```

Browser contexts may contact only the run's app and backend origins; any other
request (for example the Google Fonts `@import` in `globals.css`) is aborted and
listed in the feature evidence.
