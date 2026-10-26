import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildExceptionSourceFingerprint } from "./exceptionSourceFingerprint";

const input = {
  date: "2026-09-03", type: "scan_sequence", workerId: "synthetic-worker",
  attendanceEvents: Array.from({ length: 500 }, (_, index) => ({
    _id: `synthetic-${index}`, eventType: "clock_in", timestamp: "2026-09-03T08:00:00",
    chronologicalKey: "2026-09-03T13:00:00.000", kioskId: "synthetic-kiosk",
  })),
};

it("keeps evidence identity bounded even when a worker has many scans", () => {
  const fingerprint = buildExceptionSourceFingerprint(input);
  expect(fingerprint).toMatch(/^v1:sha256:[0-9a-f]{64}$/);
  // Every scan-sequence exception carries this value; embedding the complete
  // day here would grow the queue payload quadratically with the scan count.
  expect(fingerprint.length * input.attendanceEvents.length).toBeLessThan(40_000);
});

it("preserves canonical identity across enumeration order and detects changed evidence", () => {
  const fingerprint = buildExceptionSourceFingerprint(input);
  expect(buildExceptionSourceFingerprint({ ...input, attendanceEvents: [...input.attendanceEvents].reverse() })).toBe(fingerprint);
  expect(buildExceptionSourceFingerprint({ ...input, attendanceEvents: input.attendanceEvents.slice(1) })).not.toBe(fingerprint);
  expect(buildExceptionSourceFingerprint({ ...input, type: "missing_clock_out" })).not.toBe(fingerprint);
});

it("uses SHA-256 of the canonical v1 evidence", () => {
  const canonical = JSON.stringify({
    version: 1, date: "2026-09-03", type: "missing_arrival", workerId: "worker",
    attendanceEvents: [], schedule: null, recognitionAttempt: null,
  });
  expect(buildExceptionSourceFingerprint({ date: "2026-09-03", type: "missing_arrival", workerId: "worker" }))
    .toBe(`v1:sha256:${createHash("sha256").update(canonical).digest("hex")}`);
});
