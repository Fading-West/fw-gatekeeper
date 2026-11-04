# Activity proxy rejects unusable upstream responses

At master 9783d7c0, the activity route labels every upstream body application/json,
even HTML or malformed JSON, and retains a 200 status. A gateway error therefore
looks successful at the HTTP boundary and cannot be decoded by an API consumer.
The diagnostic header did not make that response usable.

The route now requires the application/json media type and parseable JSON before
forwarding the original body/status. It returns the existing generic 502 error
for unusable responses without logging upstream body contents. Valid JSON 200,
401 and 403 responses retain their behavior. This does not validate feed schema.

Observed proof in this session: from the checkout root run
`node docs/reviews/evidence/nov04-activity-json/probe.cjs "$PWD"`.
The probe transpiles the actual route with the installed TypeScript compiler,
stubs only the upstream fetch, and uses native Response/Headers. On unchanged
master it failed five invalid-response cases; after the guard all seven cases
pass, including valid 200 and 403 passthrough. Outputs are alongside the probe.
The Vitest regression suite additionally asserts no upstream diagnostics leak.

Local Vitest did not start: `flock -w 15` timed out on the shared heavy lock.
Lint, typecheck, full tests and build are blocked by the same lock; no installs
or Docker builds were performed. Gatekeeper has no onboarded verify-* package.
GitHub CI at the exact pushed head is required; skipped stages after known
arrival-review failures must be listed separately. Unchanged master CI run
41398123572 at 9783d7c0 is the baseline.

Scope: one response-contract bug. No migrations, auth/permissions, payroll,
security-policy or deployment configuration changes. No production deploy.
