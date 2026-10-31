# Portal enrollment camera disconnection — October 31, 2026

Daily card: https://trello.com/c/1Rja8Qip
Base: origin/master at 382a6145131b675b059ef9009919ed823617a4f8.
Checked open/recent PRs and October 26–30 daily work. This portal capture issue
is separate from #248 (local kiosk enrollment) and #165 (face-service crop parity).
No edited files overlap open PRs.

A video can retain its last frame and HAVE_CURRENT_DATA (readyState 2) after its
camera track ends. Enrollment checked video readiness and dimensions but never
checked track liveness or listened for `ended`. Disconnecting a webcam during
capture therefore allowed three canvas snapshots of a frozen frame to be sent
to `/api/enroll`.

Observed before-fix proof: two lifecycle tests failed when an EventTarget video
track ended while video readyState stayed at 2. After the first capture, the
original page reached “Enrolled!” and sent an enrollment POST. The fixed page
stops capture, clears images/readiness/consent, and offers reconnect/retry.
Track liveness is checked during capture even if the ended event is delayed;
old track listeners are removed before replacing the stream.

The Chromium regression uses a real canvas-backed MediaStream/video and emits
the ended event after stopping its track (programmatic stop itself does not
emit it). It verifies that no POST arrives after all capture deadlines pass.
Screenshots from this session:

- [Capture before disconnect](evidence/oct31-portal-camera/capture-before-disconnect.png)
- [Reconnect message after disconnect](evidence/oct31-portal-camera/camera-disconnected.png)

Run `npx vitest run src/app/enroll` (Chromium installed) for lifecycle/browser
coverage. Full check and independent exact-head audit results are in the PR.
This tests a standards-based synthetic disconnection, not a physical USB camera.

Scope: biometric capture integrity. No auth policy, payroll calculation, schema
migration or deployment configuration change. No merge or deployment.
