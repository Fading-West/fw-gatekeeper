/** Canonical evidence identity shared by corrections and exception reviews.
 * Keep v1 fields identical across branches. Review notes/status and generation
 * time are deliberately excluded, so disposition writes do not change identity.
 */
type AttendanceSource = {
  _id: string; eventType: string; timestamp: string; chronologicalKey?: string;
  kioskId?: string; correctionId?: string;
};
type ScheduleSource = {
  _id: string; name: string; days: string; startTime: string; endTime: string; department?: string;
};
type RecognitionSource = {
  id: string; timestamp: string; decision: string; kioskId: string | null;
  candidateWorkerId: string | null; scoreMargin: number | null;
  bestScore: number | null; secondBestScore: number | null; threshold: number | null;
  modelVersion: string | null; livenessConfirmed: boolean | null;
};
export function buildExceptionSourceFingerprint(input: {
  date: string; type: string; workerId: string | null;
  attendanceEvents?: readonly AttendanceSource[];
  schedule?: ScheduleSource | null;
  recognitionAttempt?: RecognitionSource | null;
}): string {
  const schedule = input.schedule;
  let days: number[] = [];
  if (schedule) {
    try {
      const parsed: unknown = JSON.parse(schedule.days);
      if (Array.isArray(parsed)) days = [...new Set(parsed.filter((day): day is number => Number.isInteger(day)))].sort((a, b) => a - b);
    } catch { /* Invalid days select no schedule. */ }
  }
  return JSON.stringify({
    version: 1,
    date: input.date,
    type: input.type,
    workerId: input.workerId,
    // Bind to the complete effective day: earlier scans affect sequence evidence.
    // Sort by ID for deterministic identity independent of query enumeration.
    attendanceEvents: [...(input.attendanceEvents ?? [])].map(event => ({
      id: String(event._id),
      eventType: event.eventType,
      timestamp: event.timestamp,
      chronologicalKey: event.chronologicalKey ?? null,
      kioskId: event.kioskId ?? null,
      correctionId: event.correctionId ?? null,
    })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    schedule: schedule ? {
      id: String(schedule._id), name: schedule.name, days,
      department: schedule.department?.trim().toLowerCase() || null,
      startTime: schedule.startTime, endTime: schedule.endTime,
    } : null,
    recognitionAttempt: input.recognitionAttempt ? {
      id: input.recognitionAttempt.id, timestamp: input.recognitionAttempt.timestamp,
      decision: input.recognitionAttempt.decision, kioskId: input.recognitionAttempt.kioskId,
      candidateWorkerId: input.recognitionAttempt.candidateWorkerId,
      scoreMargin: input.recognitionAttempt.scoreMargin,
      bestScore: input.recognitionAttempt.bestScore, secondBestScore: input.recognitionAttempt.secondBestScore,
      threshold: input.recognitionAttempt.threshold, modelVersion: input.recognitionAttempt.modelVersion,
      livenessConfirmed: input.recognitionAttempt.livenessConfirmed,
    } : null,
  });
}
