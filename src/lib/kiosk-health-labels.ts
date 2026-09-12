/** Distinguish legacy optional degradation from verification that blocks scans. */
export const KIOSK_DEGRADED_REASON_LABELS: Record<string, string> = {
  camera_error: 'camera failure — the kiosk cannot scan',
  model_error: 'recognition model failed to load — all scans are rejected',
  encoding_mismatch: 'face encodings do not match the kiosk model — all workers are rejected',
  no_workers_synced: 'no workers synced — every scan is rejected',
  liveness_unavailable: 'optional blink verification unavailable — scans are recorded unverified',
  liveness_required_unavailable: 'required blink verification unavailable — automatic attendance is paused; restore the landmark model or contact a supervisor',
};
