export interface Worker {
  id: string;
  name: string;
  employee_id?: string;
  department: string;
  photo_url: string | null;
  has_face_encoding?: boolean;
  encoding_status?: 'valid' | 'missing' | 'invalid';
  enrolled_at: string;
  active: number;
}

export interface AttendanceEvent {
  id: string;
  worker_id: string;
  event_type: 'clock_in' | 'clock_out';
  kiosk_id: string | null;
  timestamp: string;
  timestamp_utc?: string | null;
  synced: number;
  source?: 'kiosk' | 'correction';
  note?: string | null;
  corrected?: boolean;
  correction_id?: string | null;
  correction_reason?: string | null;
  correction_supervisor_name?: string | null;
}

export interface Kiosk {
  id: string;
  name: string;
  kiosk_id: string | null;
  type: 'entry' | 'exit';
  location: string;
  last_sync: string | null;
  active: number;
}

export interface AttendanceWithWorker extends AttendanceEvent {
  worker_name: string;
  worker_department: string;
  kiosk_name?: string;
}

export interface DashboardStats {
  totalWorkers: number;
  clockedIn: number;
  clockedOut: number;
  notArrived: number;
  scheduleWarning?: string;
}

export interface Schedule {
  id: string;
  name: string;
  days: string; // JSON array e.g. '[1,2,3,4,5]'
  start_time: string;
  end_time: string;
  department: string | null;
  active: number;
  created_at: string;
}

export type RecognitionDecision = string;
export type RecognitionReviewStatus = 'unreviewed' | 'confirmed' | 'corrected' | 'ignored';
export type RecognitionConfidenceBand = 'high' | 'medium' | 'low';

export interface RecognitionAttempt {
  id: string;
  kiosk_id: string | null;
  kiosk_name?: string | null;
  candidate_worker_id?: string | null;
  candidate_worker_name?: string | null;
  decision: RecognitionDecision;
  review_status: RecognitionReviewStatus;
  confidence_band?: RecognitionConfidenceBand | null;
  score: number | null;
  second_score?: number | null;
  margin: number | null;
  threshold?: number | null;
  liveness_passed?: boolean | null;
  timestamp: string;
  reviewed_at?: string | null;
  review_note?: string | null;
  model_version?: string | null;
}

export interface RecognitionAttemptSummary {
  accepted: number;
  rejected: number;
  unknown: number;
  near_miss: number;
  low_margin_accepted: number;
  median_score: number | null;
  review_backlog: number;
  total: number;
}

export interface RecognitionAttemptsResponse {
  attempts: RecognitionAttempt[];
  summary: RecognitionAttemptSummary;
  backend_unavailable?: boolean;
  warning?: string;
}

export type ShiftExceptionSeverity = 'critical' | 'warning' | 'info';
export type ShiftExceptionStatus = 'open' | 'reviewed' | 'ignored' | 'resolved';
export type ShiftExceptionSuggestedResolutionAction =
  | 'review_only'
  | 'add_clock_in'
  | 'add_clock_out'
  | 'void_event'
  | 'open_recognition_review';

export interface ShiftExceptionSuggestedResolution {
  action: ShiftExceptionSuggestedResolutionAction;
  label: string;
  cta: string;
  reason: string;
  corrected_time: string | null;
  original_attendance_id: string | null;
  href: string | null;
  source_href: string | null;
  requires_worker: boolean;
  requires_original_event: boolean;
  can_apply: boolean;
  disabled_reason: string | null;
  source_exception_key: string;
}

export interface ShiftException {
  key: string;
  date: string;
  type: string;
  severity: ShiftExceptionSeverity;
  status: ShiftExceptionStatus;
  title: string;
  description: string;
  worker_id: string | null;
  worker_name: string | null;
  department: string | null;
  kiosk_id: string | null;
  kiosk_name: string | null;
  first_seen: string | null;
  last_seen: string | null;
  schedule_name: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  event_count: number;
  attendance_id?: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  suggested_resolution: ShiftExceptionSuggestedResolution;
  links: {
    activity_log?: string;
    worker?: string;
    recognition_lab?: string;
    kiosk?: string;
    schedules?: string;
  };
}

export type AttendanceCorrectionAction = 'add_clock_in' | 'add_clock_out' | 'void_event';

export interface AttendanceCorrection {
  id: string;
  date: string;
  worker_id: string;
  worker_name: string;
  worker_department: string;
  action: AttendanceCorrectionAction;
  event_type: 'clock_in' | 'clock_out' | null;
  corrected_timestamp: string | null;
  original_attendance_id: string | null;
  original_timestamp: string | null;
  original_event_type: string | null;
  related_exception_key: string | null;
  reason: string;
  supervisor_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttendanceCorrectionsResponse {
  date: string;
  corrections: AttendanceCorrection[];
  backend_unavailable?: boolean;
  warning?: string;
}

export interface ShiftExceptionSummary {
  total: number;
  open: number;
  critical: number;
  warning: number;
  info: number;
  by_severity: Record<ShiftExceptionSeverity, number>;
  by_type: Record<string, number>;
  by_status: Record<ShiftExceptionStatus, number>;
}

export interface ShiftExceptionsResponse {
  date: string;
  generated_at: string;
  exceptions: ShiftException[];
  summary: ShiftExceptionSummary;
  backend_unavailable?: boolean;
  warning?: string;
}

export type WorkerCoverageStatus = 'present' | 'late' | 'missing' | 'clocked_out' | 'still_clocked_in';
export type DepartmentCoverageStatus = 'covered' | 'short' | 'critical' | 'unscheduled';
export type ShiftBriefingActionPriority = 'critical' | 'warning' | 'info';
export type ShiftBriefingKioskStatus = 'online' | 'stale' | 'offline' | 'never_synced';

export interface ShiftBriefingDepartment {
  department: string;
  schedule_name: string;
  scheduled_start: string;
  scheduled_end: string;
  expected: number;
  present: number;
  late: number;
  missing: number;
  clocked_out: number;
  status: DepartmentCoverageStatus;
}

export interface ShiftBriefingWorker {
  worker_id: string;
  worker_name: string;
  department: string;
  schedule_name: string;
  scheduled_start: string;
  scheduled_end: string;
  status: WorkerCoverageStatus;
  first_seen: string | null;
  last_seen: string | null;
  event_count: number;
}

export interface ShiftBriefingActionItem {
  id: string;
  priority: ShiftBriefingActionPriority;
  label: string;
  description: string;
  href: string;
}

export type ShiftTrustBriefStatus = 'ready' | 'attention' | 'blocked';
export type ShiftTrustBriefRiskCategory = 'kiosk' | 'enrollment' | 'schedule' | 'exception' | 'correction' | 'attendance';

export interface ShiftTrustBriefRisk {
  id: string;
  category: ShiftTrustBriefRiskCategory;
  severity: ShiftBriefingActionPriority;
  label: string;
  description: string;
  count: number;
  href: string;
  exact: boolean;
}

export interface ShiftTrustBriefPrimaryAction extends ShiftBriefingActionItem {
  cta: string;
  source_label: string;
  proof_label: string;
  exact: boolean;
}

export interface ShiftTrustBriefSourceCounts {
  expected: number;
  present: number;
  late: number;
  missing: number;
  open_exceptions: number;
  critical_exceptions: number;
  recognition_reviews: number;
  missing_clock_outs: number;
  corrections: number;
  kiosk_warnings: number;
}

export interface ShiftTrustBrief {
  readiness_status: ShiftTrustBriefStatus;
  summary_sentence: string;
  primary_action: ShiftTrustBriefPrimaryAction | null;
  readiness_blockers: ShiftTrustBriefRisk[];
  closeout_risks: ShiftTrustBriefRisk[];
  source_counts: ShiftTrustBriefSourceCounts;
  generated_at: string;
  freshness: {
    label: string;
    generated_at: string;
  };
  source_labels: string[];
}

export interface ShiftBriefingKiosk {
  id: string;
  name: string;
  kiosk_id: string | null;
  type: string;
  location: string;
  last_sync: string | null;
  status: ShiftBriefingKioskStatus;
}

export interface ShiftBriefingResponse {
  date: string;
  generated_at: string;
  summary: {
    expected: number;
    present: number;
    late: number;
    missing: number;
    clocked_out: number;
    departments: number;
    open_exceptions: number;
    recognition_reviews: number;
    critical_actions: number;
    kiosk_warnings: number;
  };
  departments: ShiftBriefingDepartment[];
  workers: ShiftBriefingWorker[];
  action_items: ShiftBriefingActionItem[];
  kiosks: {
    total: number;
    counts: Record<ShiftBriefingKioskStatus, number>;
    rows: ShiftBriefingKiosk[];
  };
  schedules: {
    active_today: number;
    total_active: number;
  };
  shift_trust_brief: ShiftTrustBrief;
  backend_unavailable?: boolean;
  warning?: string;
}

export type ShiftCloseoutStatus = 'open' | 'completed' | 'reopened';
export type ShiftCloseoutChecklistStatus = 'clear' | 'blocked';

export interface ShiftCloseoutSnapshot {
  expected: number;
  present: number;
  late: number;
  missing: number;
  open_exceptions: number;
  critical_exceptions: number;
  kiosk_warnings: number;
}

export interface ShiftCloseoutRecord {
  id: string;
  date: string;
  status: ShiftCloseoutStatus;
  supervisor_name: string | null;
  notes: string;
  acknowledged_blockers: boolean;
  completed_at: string | null;
  reopened_at: string | null;
  updated_at: string;
  snapshot: ShiftCloseoutSnapshot;
}

export interface ShiftCloseoutChecklistItem {
  id: string;
  label: string;
  status: ShiftCloseoutChecklistStatus;
  count: number;
  href: string;
  source_exception_key?: string | null;
  proof: {
    label: string;
    count: number;
    href: string;
    exact: boolean;
  };
  description: string;
}

export interface ShiftCloseoutDraftSourceLink {
  label: string;
  href: string;
  count: number;
  exact: boolean;
}

export interface ShiftCloseoutDraftSection {
  id: 'attendance_summary' | 'exceptions_reviewed' | 'kiosk_trust_caveats' | 'corrections_applied' | 'blocker_acknowledgement' | string;
  title: string;
  paragraph: string;
  source_links: ShiftCloseoutDraftSourceLink[];
}

export interface ShiftCloseoutDraft {
  generated_at: string;
  source_counts: ShiftCloseoutSnapshot & {
    missing_clock_outs: number;
    recognition_reviews: number;
    attendance_corrections: number;
    total_exceptions: number;
    reviewed_exceptions: number;
    source_blockers: number;
  };
  source_links: ShiftCloseoutDraftSourceLink[];
  sections: ShiftCloseoutDraftSection[];
  narrative: string;
}

export interface ShiftCloseoutResponse {
  date: string;
  generated_at: string;
  closeout: ShiftCloseoutRecord | null;
  summary: ShiftCloseoutSnapshot & {
    missing_clock_outs: number;
    recognition_reviews: number;
    attendance_corrections: number;
  };
  checklist: ShiftCloseoutChecklistItem[];
  blockers: ShiftCloseoutChecklistItem[];
  can_complete: boolean;
  suggested_note: string;
  closeout_draft: ShiftCloseoutDraft;
  action_links: Array<{ label: string; href: string }>;
  backend_unavailable?: boolean;
  warning?: string;
}
