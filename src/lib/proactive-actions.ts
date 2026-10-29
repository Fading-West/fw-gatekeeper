import { formatFactoryLocalDateTime } from './date';

export type ProactiveActionPriority = 'critical' | 'warning' | 'closeout' | 'info';
export type ProactiveActionSeverity = 'critical' | 'warning' | 'info';
export type ProactiveActionTone = 'red' | 'amber' | 'slate';
export type ProactiveActionSource = 'service' | 'kiosk' | 'enrollment' | 'exceptions' | 'schedule' | 'signal' | 'closeout' | 'attendance';
export type ProactiveActionAccess = 'operate' | 'review';
export type ProactiveActionFreshnessStatus = 'fresh' | 'stale' | 'unknown';
export type ProactiveActionFreshnessReason = 'current-signal-failure' | 'signal-unavailable' | 'signal-stale' | 'signal-current' | 'not-provided';

export type SignalFailureKey = 'stats' | 'workers' | 'attendance' | 'system-health' | 'shift-exceptions' | 'shift-closeout' | string;

export interface ProactiveSignalFreshness {
  lastSuccessAt?: string | null;
  failed?: boolean;
  current?: boolean;
  unavailable?: boolean;
  message?: string | null;
}

export interface ProactiveActionFreshness extends ProactiveSignalFreshness {
  status: ProactiveActionFreshnessStatus;
  reason: ProactiveActionFreshnessReason;
  sourceKeys: string[];
}

export interface ProactiveSignalFailure {
  key: SignalFailureKey;
  label: string;
  href: string;
  message: string;
}

export interface ProactiveWorker {
  id: string;
  name?: string;
  department?: string;
  has_face_encoding?: boolean;
  encoding_status?: 'valid' | 'missing' | 'invalid' | string;
  status?: 'in' | 'out' | 'absent' | string;
}

export interface ProactiveStats {
  totalWorkers?: number;
  notArrived?: number;
  scheduleWarning?: string;
}

export interface ProactiveSystemHealth {
  checked_at?: string;
  kiosks?: {
    total?: number;
    counts?: {
      online?: number;
      stale?: number;
      offline?: number;
      never_synced?: number;
      [key: string]: number | undefined;
    };
  };
  warnings?: string[];
}

export interface ProactiveShiftExceptions {
  date?: string;
  backend_unavailable?: boolean;
  warning?: string;
  exceptions?: Array<{
    key?: string;
    type?: string;
    status?: string;
    severity?: string;
  }>;
  summary?: {
    total?: number;
    open?: number;
    critical?: number;
    warning?: number;
    info?: number;
    by_type?: Record<string, number>;
    by_status?: Record<string, number>;
  };
}

export interface ProactiveShiftCloseout {
  date?: string;
  backend_unavailable?: boolean;
  warning?: string;
  closeout?: {
    status?: 'open' | 'completed' | 'reopened' | string;
    completed_at?: string | null;
  } | null;
  summary?: Record<string, unknown>;
  blockers?: Array<{
    id?: string;
    label?: string;
    proof?: {
      label?: string;
      count?: number;
      href?: string;
      exact?: boolean;
    };
  }>;
  can_complete?: boolean;
}

export interface BuildProactiveActionsInput {
  date?: string | null;
  signalFailures?: ProactiveSignalFailure[];
  signalFreshness?: Record<string, ProactiveSignalFreshness | null | undefined>;
  workers?: ProactiveWorker[];
  systemHealth?: ProactiveSystemHealth | null;
  stats?: ProactiveStats;
  shiftExceptions?: ProactiveShiftExceptions | null;
  shiftCloseout?: ProactiveShiftCloseout | null;
  currentRole?: 'admin' | 'enrollment' | 'viewer' | string;
}

export interface ProactiveActionActionability {
  access: ProactiveActionAccess;
  canOperate: boolean;
  role: string | null;
}

export interface ProactiveAction {
  key: string;
  priority: ProactiveActionPriority;
  severity: ProactiveActionSeverity;
  tone: ProactiveActionTone;
  label: string;
  value: string | number;
  description: string;
  href: string;
  cta: string;
  source: ProactiveActionSource;
  evidence: Record<string, unknown>;
  freshness: ProactiveActionFreshness;
  blocksReadiness: boolean;
  blocksCloseout: boolean;
  actionability: ProactiveActionActionability;
}

export interface ProactiveShiftTrustPlan {
  actionKey: string;
  label: string;
  description: string;
  impactLabel: string;
  href: string;
  cta: string;
  evidenceChips: string[];
  outcomeChips: string[];
  proofLink: ProactiveActionProofLink | null;
  tone: ProactiveActionTone;
  access: ProactiveActionAccess;
  stale: boolean;
  staleLabel: string | null;
  unlocks: string[];
}

export interface ProactiveActionProofLink {
  href: string;
  label: string;
}

export type LiveShiftSentinelStatus = 'new' | 'changed' | 'current' | 'seen';
export type LiveShiftSentinelKind =
  | 'critical-exception'
  | 'kiosk-trust'
  | 'closeout-blocked'
  | 'recognition-review'
  | 'missing-clock-out'
  | 'signal-unavailable';

export interface LiveShiftSentinelItem {
  key: string;
  signature: string;
  status: LiveShiftSentinelStatus;
  kind: LiveShiftSentinelKind;
  priority: ProactiveActionPriority;
  severity: ProactiveActionSeverity;
  tone: ProactiveActionTone;
  label: string;
  description: string;
  href: string;
  cta: string;
  source: ProactiveActionSource;
  evidenceChips: string[];
  outcomeChips: string[];
  freshnessLabel: string | null;
  acknowledged: boolean;
  changedSinceSeen: boolean;
  proofLink: ProactiveActionProofLink | null;
  actionability: ProactiveActionActionability;
}

export type LiveShiftSentinelSnapshot = Record<string, string>;

type DraftProactiveAction = Omit<ProactiveAction, 'priority' | 'severity' | 'tone' | 'source' | 'freshness' | 'blocksReadiness' | 'blocksCloseout' | 'actionability'> & {
  priority?: ProactiveActionPriority;
  severity?: ProactiveActionSeverity;
  tone?: ProactiveActionTone;
  source?: ProactiveActionSource;
  freshness?: ProactiveActionFreshness;
  blocksReadiness?: boolean;
  blocksCloseout?: boolean;
  actionability?: ProactiveActionActionability;
};

type RankedProactiveAction = ProactiveAction & {
  sort: {
    priority: number;
    source: number;
    severity: number;
    original: number;
  };
};

const CRITICAL_PRIORITY: ProactiveActionPriority = 'critical';
const WARNING_PRIORITY: ProactiveActionPriority = 'warning';
const CLOSEOUT_PRIORITY: ProactiveActionPriority = 'closeout';
const INFO_PRIORITY: ProactiveActionPriority = 'info';

export const PROACTIVE_ACTION_PRIORITY_RANK = Object.freeze({
  [CRITICAL_PRIORITY]: 0,
  [WARNING_PRIORITY]: 1,
  [CLOSEOUT_PRIORITY]: 2,
  [INFO_PRIORITY]: 3,
});

const SOURCE_RANK = Object.freeze({
  service: 0,
  kiosk: 1,
  enrollment: 2,
  exceptions: 3,
  schedule: 4,
  signal: 5,
  closeout: 6,
  attendance: 7,
});

const ENROLLMENT_OPERATE_SOURCES = new Set<ProactiveActionSource>(['enrollment', 'exceptions', 'closeout']);

function plural(count: number, singular: string, pluralValue?: string) {
  return `${count} ${count === 1 ? singular : pluralValue || `${singular}s`}`;
}

function verb(count: number, singular: string, pluralValue: string) {
  return count === 1 ? singular : pluralValue;
}

function hasOwn(input: object | null | undefined, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function getOpenExceptionCount(shiftExceptions: ProactiveShiftExceptions | null) {
  return Number(shiftExceptions?.summary?.open || 0);
}

function getCriticalExceptionCount(shiftExceptions: ProactiveShiftExceptions | null) {
  return Number(shiftExceptions?.summary?.critical || 0);
}

function getOpenExceptionTypeCount(shiftExceptions: ProactiveShiftExceptions | null, type: string) {
  return getOpenExceptionTypeEntries(shiftExceptions, type).length || getOpenExceptionTypeFallbackCount(shiftExceptions, type);
}

function getOpenExceptionTypeEntries(shiftExceptions: ProactiveShiftExceptions | null, type: string) {
  const exceptions = Array.isArray(shiftExceptions?.exceptions) ? shiftExceptions.exceptions : [];
  return exceptions.filter((exception) => exception?.status === 'open' && exception?.type === type);
}

function getOpenExceptionTypeFallbackCount(shiftExceptions: ProactiveShiftExceptions | null, type: string) {
  const exceptions = Array.isArray(shiftExceptions?.exceptions) ? shiftExceptions.exceptions : [];
  if (exceptions.length > 0) return 0;
  const summary = shiftExceptions?.summary;
  const totalExceptions = Number(summary?.total || 0);
  const openExceptions = Number(summary?.open || summary?.by_status?.open || 0);
  const typeCount = Number(summary?.by_type?.[type] || 0);

  return totalExceptions > 0 && openExceptions === totalExceptions ? typeCount : 0;
}

function getFirstOpenExceptionKey(shiftExceptions: ProactiveShiftExceptions | null, type: string) {
  return getOpenExceptionTypeEntries(shiftExceptions, type).find((exception) => exception.key)?.key || null;
}

function getOpenExceptionTypeKeys(shiftExceptions: ProactiveShiftExceptions | null, type: string) {
  return uniqueKeys(getOpenExceptionTypeEntries(shiftExceptions, type).map((exception) => exception.key));
}

function getOpenExceptionKeys(shiftExceptions: ProactiveShiftExceptions | null) {
  const exceptions = Array.isArray(shiftExceptions?.exceptions) ? shiftExceptions.exceptions : [];
  return exceptions
    .filter((exception) => exception?.status === 'open' && exception.key)
    .map((exception) => String(exception.key));
}

function getOpenCriticalExceptionKeys(shiftExceptions: ProactiveShiftExceptions | null) {
  const exceptions = Array.isArray(shiftExceptions?.exceptions) ? shiftExceptions.exceptions : [];
  return exceptions
    .filter((exception) => exception?.status === 'open' && exception?.severity === 'critical' && exception.key)
    .map((exception) => String(exception.key));
}

function isCriticalSystemWarning(warning: string) {
  const normalized = String(warning).toLowerCase();
  return (
    normalized.includes('offline') ||
    normalized.includes('never synced') ||
    normalized.includes('not ready') ||
    normalized.includes('unavailable')
  );
}

function isFaceServiceWarning(warning: string) {
  return String(warning).toLowerCase().includes('face service');
}

function getSignalPriority(failure: ProactiveSignalFailure): ProactiveActionPriority {
  return failure?.key === 'system-health' || failure?.key === 'workers' ? CRITICAL_PRIORITY : WARNING_PRIORITY;
}

function getSignalSource(failure: ProactiveSignalFailure): ProactiveActionSource {
  if (failure?.key === 'system-health') return 'service';
  if (failure?.key === 'workers') return 'enrollment';
  if (failure?.key === 'shift-exceptions') return 'exceptions';
  if (failure?.key === 'shift-closeout') return 'closeout';
  if (failure?.key === 'attendance') return 'attendance';
  return 'signal';
}

function uniqueKeys(keys: Array<string | null | undefined>) {
  return [...new Set(keys.filter((key): key is string => Boolean(key)))];
}

function getUnknownFreshness(sourceKeys: string[]): ProactiveActionFreshness {
  return {
    status: 'unknown',
    reason: 'not-provided',
    sourceKeys,
  };
}

function normalizeFreshness(
  sourceKeys: string[],
  freshness?: ProactiveSignalFreshness | null,
  fallback?: Partial<ProactiveActionFreshness>,
): ProactiveActionFreshness {
  if (!freshness) {
    return fallback
      ? { ...getUnknownFreshness(sourceKeys), ...fallback, sourceKeys }
      : getUnknownFreshness(sourceKeys);
  }

  const staleBecauseCurrentFailure = freshness.failed === true && freshness.current === true;
  const unavailable = freshness.unavailable === true || staleBecauseCurrentFailure || freshness.failed === true;
  const status: ProactiveActionFreshnessStatus = unavailable
    ? 'stale'
    : freshness.current === true || Boolean(freshness.lastSuccessAt)
      ? 'fresh'
      : 'unknown';
  const reason: ProactiveActionFreshnessReason = staleBecauseCurrentFailure
    ? 'current-signal-failure'
    : unavailable
      ? 'signal-unavailable'
      : status === 'fresh'
        ? 'signal-current'
        : 'signal-stale';

  return {
    ...freshness,
    status,
    reason,
    unavailable,
    sourceKeys,
  };
}

function getFreshness(
  signalFreshness: BuildProactiveActionsInput['signalFreshness'],
  sourceKeys: Array<string | null | undefined>,
  fallback?: Partial<ProactiveActionFreshness>,
) {
  const keys = uniqueKeys(sourceKeys);
  const matchedKey = keys.find((key) => signalFreshness && hasOwn(signalFreshness, key));
  return normalizeFreshness(keys, matchedKey ? signalFreshness?.[matchedKey] : null, fallback);
}

function buildHref(path: string, params: Record<string, string | number | null | undefined>) {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `${path}?${query}` : path;
}

function getFirstWorkerId(workers: ProactiveWorker[]) {
  return workers.find((worker) => worker.id)?.id || null;
}

function getEnrollmentHref(workers: ProactiveWorker[]) {
  return buildHref('/enroll', { worker_id: getFirstWorkerId(workers) });
}

function stripHrefParams(href: string, keysToStrip: string[]) {
  const [path, query = ''] = href.split('?');
  if (!query) return href;
  const blocked = new Set(keysToStrip);
  const nextQuery = query
    .split('&')
    .filter((entry) => {
      const key = decodeURIComponent(entry.split('=')[0] || '');
      return !blocked.has(key);
    })
    .join('&');
  return nextQuery ? `${path}?${nextQuery}` : path;
}

function getSeverityForPriority(priority: ProactiveActionPriority): ProactiveActionSeverity {
  return priority === CRITICAL_PRIORITY ? 'critical' : priority === WARNING_PRIORITY ? 'warning' : 'info';
}

function getToneForPriority(priority: ProactiveActionPriority): ProactiveActionTone {
  return priority === CRITICAL_PRIORITY ? 'red' : priority === WARNING_PRIORITY ? 'amber' : 'slate';
}

function normalizeRole(role: BuildProactiveActionsInput['currentRole']) {
  if (typeof role !== 'string') return null;
  const normalized = role.trim().toLowerCase();
  return normalized || null;
}

function canRoleOperate(role: string | null, source: ProactiveActionSource) {
  if (!role) return true;
  if (role === 'admin') return true;
  if (role === 'enrollment') return ENROLLMENT_OPERATE_SOURCES.has(source);
  return false;
}

function canActionOperate(action: ProactiveAction, role: string | null) {
  if (!canRoleOperate(role, action.source)) return false;
  if (role === 'enrollment' && action.source === 'enrollment') return action.href.startsWith('/enroll?worker_id=');
  return true;
}

function getReviewHref(action: ProactiveAction, date: string | null) {
  const briefingHref = buildHref('/briefing', { date });
  if (action.source === 'exceptions') return stripHrefParams(action.href, ['intent']);
  if (action.source === 'closeout') return action.href;
  if (action.source === 'schedule') return briefingHref;
  if (action.source === 'attendance') return action.href;
  if (action.source === 'enrollment') return briefingHref;
  if (action.source === 'kiosk' || action.source === 'service') return briefingHref;
  return action.href === '/kiosks' || action.href === '/workers' || action.href === '/schedules' ? briefingHref : action.href;
}

function getReviewCta(action: ProactiveAction) {
  if (action.key === 'missing-clock-outs') return 'Review clock-outs';
  if (action.key === 'recognition-review') return 'Review recognition';
  if (action.key === 'not-arrived') return 'Review missing';
  if (action.source === 'exceptions') return 'Review exceptions';
  if (action.source === 'closeout') return 'Review closeout';
  if (action.source === 'schedule') return 'Inspect briefing';
  if (action.source === 'attendance') return 'Inspect briefing';
  if (action.source === 'enrollment') return 'Inspect briefing';
  if (action.source === 'kiosk' || action.source === 'service') return 'Inspect readiness';
  return action.cta.startsWith('Open') ? action.cta.replace('Open', 'Inspect') : 'Inspect details';
}

function getOperateHref(action: ProactiveAction, role: string | null) {
  if (role === 'enrollment' && action.source === 'enrollment') return action.href.startsWith('/enroll') ? action.href : '/enroll';
  return action.href;
}

function getOperateCta(action: ProactiveAction, role: string | null) {
  if (role === 'enrollment' && action.source === 'enrollment') return 'Enroll face';
  if (
    (role === 'admin' || role === 'enrollment') &&
    action.key === 'shift-closeout-pending' &&
    action.evidence?.canComplete === false
  ) {
    return 'Review closeout';
  }
  return action.cta;
}

function applyRoleActionability(actions: ProactiveAction[], role: BuildProactiveActionsInput['currentRole'], date: string | null) {
  const normalizedRole = normalizeRole(role);
  return actions.map((action) => {
    const canOperate = canActionOperate(action, normalizedRole);
    const actionability: ProactiveActionActionability = {
      access: canOperate ? 'operate' : 'review',
      canOperate,
      role: normalizedRole,
    };

    if (canOperate) {
      return {
        ...action,
        href: getOperateHref(action, normalizedRole),
        cta: getOperateCta(action, normalizedRole),
        actionability,
      };
    }

    return {
      ...action,
      href: getReviewHref(action, date),
      cta: getReviewCta(action),
      actionability,
    };
  });
}

function normalizeAction(action: DraftProactiveAction, index: number): RankedProactiveAction {
  const priority = action.priority || INFO_PRIORITY;
  const severity = action.severity || getSeverityForPriority(priority);
  const source = action.source || 'signal';
  const tone = action.tone || getToneForPriority(priority);
  return {
    ...action,
    priority,
    severity,
    tone,
    source,
    freshness: action.freshness || getUnknownFreshness([source]),
    blocksReadiness: Boolean(action.blocksReadiness),
    blocksCloseout: Boolean(action.blocksCloseout),
    actionability: action.actionability || {
      access: 'operate',
      canOperate: true,
      role: null,
    },
    sort: {
      priority: PROACTIVE_ACTION_PRIORITY_RANK[priority] ?? PROACTIVE_ACTION_PRIORITY_RANK[INFO_PRIORITY],
      source: SOURCE_RANK[source] ?? 99,
      severity: severity === CRITICAL_PRIORITY ? 0 : severity === WARNING_PRIORITY ? 1 : 2,
      original: index,
    },
  };
}

export function rankProactiveActions(actions: DraftProactiveAction[]): ProactiveAction[] {
  return actions
    .map(normalizeAction)
    .sort((a, b) => (
      a.sort.priority - b.sort.priority ||
      a.sort.source - b.sort.source ||
      a.sort.severity - b.sort.severity ||
      a.sort.original - b.sort.original
    ))
    .map(({ sort, ...action }) => action);
}

function getPlanUnlocks(action: ProactiveAction) {
  const unlocks: string[] = [];
  if (action.blocksReadiness) unlocks.push('Shift readiness');
  if (action.blocksCloseout) unlocks.push('Closeout trust');
  if (unlocks.length === 0 && action.priority === CLOSEOUT_PRIORITY) unlocks.push('Closeout signoff');
  if (unlocks.length === 0) unlocks.push('Supervisor review');
  return unlocks;
}

function getPlanImpactLabel(action: ProactiveAction, unlocks: string[]) {
  const scope = unlocks.join(' + ');
  return action.actionability.canOperate ? `Unblocks: ${scope}` : `Review focus: ${scope}`;
}

function getFreshnessSubject(sourceKeys: string[]) {
  const keys = new Set(sourceKeys);
  if (keys.has('workers')) return 'roster';
  if (keys.has('system-health')) return 'health';
  if (keys.has('attendance')) return 'attendance';
  if (keys.has('shift-exceptions')) return 'exception';
  if (keys.has('shift-closeout')) return 'closeout';
  if (keys.has('stats')) return 'stats';
  if (keys.has('kiosk')) return 'kiosk';
  if (keys.has('schedule')) return 'schedule';
  return 'source';
}

function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function getProactiveActionFreshnessLabel(freshness: ProactiveActionFreshness) {
  const subject = getFreshnessSubject(freshness.sourceKeys);
  if (freshness.lastSuccessAt) {
    return subject === 'source' ? 'Cached evidence' : `Cached ${subject} evidence`;
  }
  return subject === 'source' ? 'Source unavailable' : `${capitalize(subject)} signal unavailable`;
}

function sentenceWithPeriod(value: string) {
  return /[.!?]$/.test(value.trim()) ? value.trim() : `${value.trim()}.`;
}

function evidenceNumber(evidence: Record<string, unknown>, key: string) {
  const value = evidence[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pluralChip(count: number, singular: string, pluralValue?: string) {
  return `${count} ${count === 1 ? singular : pluralValue || `${singular}s`}`;
}

function getCloseoutBlockerDescription(blockerCount: number, firstBlockerLabel: string | null) {
  const acknowledgement = `${plural(blockerCount, 'closeout checklist item')} ${verb(blockerCount, 'needs', 'need')} acknowledgement`;
  if (!firstBlockerLabel) return `${acknowledgement}.`;
  if (blockerCount === 1) return `${acknowledgement}: ${firstBlockerLabel}.`;
  return `${acknowledgement}. Start with ${firstBlockerLabel}.`;
}

function getSignalEvidenceChip(signal: unknown) {
  if (signal === 'workers') return 'Roster signal';
  if (signal === 'attendance') return 'Attendance signal';
  if (signal === 'system-health') return 'Health signal';
  if (signal === 'shift-exceptions') return 'Exception signal';
  if (signal === 'shift-closeout') return 'Closeout signal';
  if (signal === 'stats') return 'Stats signal';
  return typeof signal === 'string' && signal ? 'Signal failed' : null;
}

export function getProactiveActionEvidenceChips(
  action: Pick<ProactiveAction, 'key' | 'source' | 'evidence' | 'actionability' | 'href'>,
) {
  const evidence = action.evidence || {};
  const chips: string[] = [];
  const count = evidenceNumber(evidence, 'count');
  const signalChip = getSignalEvidenceChip(evidence.signal);

  if (signalChip) chips.push(signalChip);

  if (action.key === 'missing-clock-outs') {
    if (count !== null) chips.push(pluralChip(count, 'clock-out'));
    if (evidence.firstExceptionKey) chips.push('Exact row ready');
  } else if (action.key === 'recognition-review') {
    if (count !== null) chips.push(pluralChip(count, 'review item'));
    if (evidence.firstExceptionKey) chips.push('Exact row ready');
  } else if (action.source === 'enrollment') {
    if (count !== null) chips.push(pluralChip(count, 'worker'));
    if (evidence.firstWorkerId) {
      chips.push(action.actionability.canOperate && action.href.startsWith('/enroll?worker_id=') ? 'Exact worker ready' : 'Worker identified');
    }
  } else if (action.source === 'kiosk') {
    const kioskCounts = evidence.kioskCounts;
    if (kioskCounts && typeof kioskCounts === 'object') {
      const counts = kioskCounts as Partial<Record<'offline' | 'stale' | 'never_synced', number>>;
      if (counts.offline) chips.push(pluralChip(counts.offline, 'offline kiosk'));
      if (counts.never_synced) chips.push(pluralChip(counts.never_synced, 'never-synced kiosk'));
      if (counts.stale) chips.push(pluralChip(counts.stale, 'stale kiosk'));
    }
  } else if (action.source === 'service') {
    if (typeof evidence.warning === 'string' && isFaceServiceWarning(evidence.warning)) chips.push('Face service warning');
    else if (evidence.warning) chips.push('Service warning');
  } else if (action.source === 'exceptions') {
    const open = evidenceNumber(evidence, 'open');
    const critical = evidenceNumber(evidence, 'critical');
    if (open !== null) chips.push(pluralChip(open, 'open exception'));
    if (critical !== null) chips.push(pluralChip(critical, 'critical item', 'critical items'));
  } else if (action.source === 'schedule') {
    if (evidence.scheduleWarning) chips.push('Schedule needs review');
  } else if (action.source === 'closeout') {
    const blockerCount = evidenceNumber(evidence, 'blockerCount');
    if (blockerCount !== null) chips.push(blockerCount > 0 ? pluralChip(blockerCount, 'blocker') : 'No blockers');
    if (evidence.status === 'completed') chips.push('Signoff complete');
    if (evidence.firstBlockerLabel) chips.push(String(evidence.firstBlockerLabel));
    const firstBlockerProof = evidence.firstBlockerProof;
    if (firstBlockerProof && typeof firstBlockerProof === 'object') {
      const proof = firstBlockerProof as Partial<{ exact: boolean }>;
      chips.push(proof.exact ? 'Exact source ready' : 'Source proof ready');
    }
    if (evidence.canComplete === false) chips.push('Needs acknowledgement');
    if (evidence.canComplete === true) chips.push('Ready to complete');
  } else if (action.source === 'attendance') {
    if (count !== null) chips.push(pluralChip(count, 'missing scan'));
    if (Array.isArray(evidence.workerIds) && evidence.workerIds.length > 0) chips.push('Worker list ready');
  }

  return chips.slice(0, 3);
}

export function buildProactiveShiftTrustPlan(actions: ProactiveAction[]): ProactiveShiftTrustPlan | null {
  const firstAction = actions[0];
  if (!firstAction) return null;

  const stale = firstAction.freshness.status === 'stale' || Boolean(firstAction.freshness.failed || firstAction.freshness.unavailable);
  const lead = firstAction.actionability.canOperate ? 'Do this first' : 'Review this first';
  const staleLabel = stale ? getProactiveActionFreshnessLabel(firstAction.freshness) : null;
  const staleCopy = staleLabel ? ` ${staleLabel}.` : '';
  const unlocks = getPlanUnlocks(firstAction);
  const impactLabel = getPlanImpactLabel(firstAction, unlocks);
  const evidenceChips = getProactiveActionEvidenceChips(firstAction);
  const outcomeChips = getProactiveActionOutcomeChips(firstAction);
  const proofLink = getProactiveActionProofLink(firstAction);

  return {
    actionKey: firstAction.key,
    label: `${lead}: ${firstAction.label}`,
    description: `${sentenceWithPeriod(firstAction.description)}${staleCopy}`,
    impactLabel,
    href: firstAction.href,
    cta: firstAction.cta,
    evidenceChips,
    outcomeChips,
    proofLink,
    tone: firstAction.tone,
    access: firstAction.actionability.access,
    stale,
    staleLabel,
    unlocks,
  };
}

export function getProactiveActionOutcomeChips(action: Pick<ProactiveAction, 'blocksReadiness' | 'blocksCloseout' | 'priority' | 'actionability'>) {
  const chips: string[] = [];
  const actionVerb = action.actionability.canOperate ? 'Clears' : 'Review';
  if (action.blocksReadiness) chips.push(`${actionVerb} shift readiness`);
  if (action.blocksCloseout) chips.push(`${actionVerb} closeout trust`);
  if (chips.length === 0 && action.priority === CLOSEOUT_PRIORITY) chips.push(`${actionVerb} closeout signoff`);
  if (chips.length === 0) chips.push('Supports supervisor review');
  return chips;
}

export function getProactiveActionProofLink(
  action: Pick<ProactiveAction, 'source' | 'evidence' | 'actionability'>,
): ProactiveActionProofLink | null {
  const proof = action.evidence?.firstBlockerProof;
  if (action.source !== 'closeout' || !proof || typeof proof !== 'object') return null;
  const firstProof = proof as Partial<{ href: string; exact: boolean }>;
  if (!firstProof.exact || !firstProof.href) return null;

  const canOpenProof = action.actionability.canOperate && action.actionability.role !== null;
  const firstBlockerLabel = typeof action.evidence?.firstBlockerLabel === 'string' ? action.evidence.firstBlockerLabel.trim() : '';
  const labelPrefix = canOpenProof ? 'Open' : 'Review';
  return {
    href: canOpenProof ? firstProof.href : stripHrefParams(firstProof.href, ['intent']),
    label: firstBlockerLabel ? `${labelPrefix} ${firstBlockerLabel} source` : `${labelPrefix} exact source`,
  };
}

function getSentinelKind(action: ProactiveAction): LiveShiftSentinelKind | null {
  const stale = action.freshness.status === 'stale' || Boolean(action.freshness.failed || action.freshness.unavailable);
  if (action.key.startsWith('signal-failure-') || action.key.endsWith('-unavailable')) return 'signal-unavailable';
  if (action.key === 'missing-clock-outs') return 'missing-clock-out';
  if (action.key === 'recognition-review') return 'recognition-review';
  if (action.source === 'kiosk' || action.source === 'service') return 'kiosk-trust';
  if (action.source === 'closeout' && action.blocksCloseout) return 'closeout-blocked';
  if (action.source === 'exceptions' && (action.priority === CRITICAL_PRIORITY || action.blocksReadiness)) return 'critical-exception';
  if (stale) return 'signal-unavailable';
  return null;
}

function getSentinelSignature(action: ProactiveAction, kind: LiveShiftSentinelKind) {
  const firstBlockerProof = action.evidence.firstBlockerProof && typeof action.evidence.firstBlockerProof === 'object'
    ? action.evidence.firstBlockerProof as Partial<{ label: string; count: number; href: string; exact: boolean }>
    : null;

  return JSON.stringify({
    kind,
    key: action.key,
    value: action.value,
    description: action.description,
    priority: action.priority,
    severity: action.severity,
    freshnessStatus: action.freshness.status,
    freshnessReason: action.freshness.reason,
    freshnessMessage: action.freshness.message || null,
    evidence: {
      count: action.evidence.count ?? null,
      open: action.evidence.open ?? null,
      critical: action.evidence.critical ?? null,
      blockerCount: action.evidence.blockerCount ?? null,
      firstExceptionKey: action.evidence.firstExceptionKey ?? null,
      matchingExceptionKeys: action.evidence.matchingExceptionKeys ?? null,
      firstBlockerLabel: action.evidence.firstBlockerLabel ?? null,
      date: action.evidence.date ?? null,
      openExceptionKeys: action.evidence.openExceptionKeys ?? null,
      criticalExceptionKeys: action.evidence.criticalExceptionKeys ?? null,
      firstBlockerProof: firstBlockerProof
        ? {
            label: firstBlockerProof.label || null,
            count: typeof firstBlockerProof.count === 'number' ? firstBlockerProof.count : null,
            href: firstBlockerProof.href || null,
            exact: firstBlockerProof.exact === true,
          }
        : null,
      status: action.evidence.status ?? null,
      signal: action.evidence.signal ?? null,
      warning: action.evidence.warning ?? null,
    },
  });
}

function getSentinelStatus(
  key: string,
  signature: string,
  seenSnapshot: LiveShiftSentinelSnapshot,
  hasSeenBaseline: boolean,
): LiveShiftSentinelStatus {
  if (seenSnapshot[key] === signature) return 'seen';
  if (hasOwn(seenSnapshot, key)) return 'changed';
  return hasSeenBaseline ? 'new' : 'current';
}

export function getLiveShiftSentinelSnapshot(items: Array<Pick<LiveShiftSentinelItem, 'key' | 'signature'>>): LiveShiftSentinelSnapshot {
  return items.reduce<LiveShiftSentinelSnapshot>((snapshot, item) => {
    snapshot[item.key] = item.signature;
    return snapshot;
  }, {});
}

export function buildLiveShiftSentinelItems(
  actions: ProactiveAction[],
  options: {
    seenSnapshot?: LiveShiftSentinelSnapshot;
    hasSeenBaseline?: boolean;
  } = {},
): LiveShiftSentinelItem[] {
  const seenSnapshot = options.seenSnapshot || {};
  const hasSeenBaseline = Boolean(options.hasSeenBaseline);

  return actions
    .map((action) => {
      const kind = getSentinelKind(action);
      if (!kind) return null;
      const signature = getSentinelSignature(action, kind);
      const status = getSentinelStatus(action.key, signature, seenSnapshot, hasSeenBaseline);
      const freshnessLabel = isActionFreshnessStaleForSentinel(action.freshness)
        ? getProactiveActionFreshnessLabel(action.freshness)
        : null;

      return {
        key: action.key,
        signature,
        status,
        kind,
        priority: action.priority,
        severity: action.severity,
        tone: action.tone,
        label: action.label,
        description: action.description,
        href: action.href,
        cta: action.cta,
        source: action.source,
        evidenceChips: getProactiveActionEvidenceChips(action),
        outcomeChips: getProactiveActionOutcomeChips(action),
        freshnessLabel,
        acknowledged: status === 'seen',
        changedSinceSeen: status === 'new' || status === 'changed',
        proofLink: getProactiveActionProofLink(action),
        actionability: action.actionability,
      } satisfies LiveShiftSentinelItem;
    })
    .filter((item): item is LiveShiftSentinelItem => Boolean(item))
    .slice(0, 6);
}

function isActionFreshnessStaleForSentinel(freshness: ProactiveActionFreshness) {
  return freshness.status === 'stale' || Boolean(freshness.failed || freshness.unavailable);
}

export function buildProactiveActions(input: BuildProactiveActionsInput = {}): ProactiveAction[] {
  const actions: DraftProactiveAction[] = [];
  const signalFailures = Array.isArray(input.signalFailures) ? input.signalFailures : [];
  const workers = Array.isArray(input.workers) ? input.workers : [];
  const systemHealth = input.systemHealth || null;
  const stats = input.stats || {};
  const shiftExceptions = input.shiftExceptions || null;
  const shiftCloseout = input.shiftCloseout || null;
  const signalFreshness = input.signalFreshness || {};
  const actionDate = input.date || shiftExceptions?.date || shiftCloseout?.date || null;

  for (const failure of signalFailures) {
    const priority = getSignalPriority(failure);
    const source = getSignalSource(failure);
    const fallbackMessage = failure.message || null;
    actions.push({
      key: `signal-failure-${failure.key}`,
      priority,
      severity: getSeverityForPriority(priority),
      label: `${failure.label} unavailable`,
      value: '!',
      description: failure.message,
      href: failure.href,
      cta: 'Open source',
      source,
      evidence: {
        signal: failure.key,
        message: failure.message,
      },
      freshness: getFreshness(signalFreshness, [failure.key, source], {
        status: 'stale',
        reason: 'current-signal-failure',
        failed: true,
        current: true,
        unavailable: true,
        message: fallbackMessage,
      }),
      blocksReadiness: priority === CRITICAL_PRIORITY,
      blocksCloseout: failure.key === 'shift-exceptions' || failure.key === 'shift-closeout',
    });
  }

  const missingFaceWorkers = workers.filter((worker) => worker.encoding_status === 'missing' || (!worker.encoding_status && !worker.has_face_encoding));
  const invalidFaceWorkers = workers.filter((worker) => worker.encoding_status === 'invalid');
  const firstInvalidFaceWorkerId = getFirstWorkerId(invalidFaceWorkers);
  const firstMissingFaceWorkerId = getFirstWorkerId(missingFaceWorkers);

  if (invalidFaceWorkers.length > 0) {
    actions.push({
      key: 'invalid-face',
      priority: CRITICAL_PRIORITY,
      severity: 'critical',
      label: 'Invalid face data',
      value: invalidFaceWorkers.length,
      description: `${plural(invalidFaceWorkers.length, 'worker')} ${verb(invalidFaceWorkers.length, 'needs', 'need')} re-enrollment because their face data is not kiosk-valid.`,
      href: getEnrollmentHref(invalidFaceWorkers),
      cta: 'Enroll face',
      source: 'enrollment',
      evidence: {
        count: invalidFaceWorkers.length,
        firstWorkerId: firstInvalidFaceWorkerId,
        workerIds: invalidFaceWorkers.map((worker) => worker.id),
      },
      freshness: getFreshness(signalFreshness, ['workers', 'enrollment']),
      blocksReadiness: true,
      blocksCloseout: false,
    });
  }

  if (missingFaceWorkers.length > 0) {
    actions.push({
      key: 'missing-face',
      priority: WARNING_PRIORITY,
      severity: 'warning',
      label: 'Face enrollment needed',
      value: missingFaceWorkers.length,
      description: `${plural(missingFaceWorkers.length, 'worker')} ${verb(missingFaceWorkers.length, 'is', 'are')} missing face data for kiosk recognition.`,
      href: getEnrollmentHref(missingFaceWorkers),
      cta: 'Enroll face',
      source: 'enrollment',
      evidence: {
        count: missingFaceWorkers.length,
        firstWorkerId: firstMissingFaceWorkerId,
        workerIds: missingFaceWorkers.map((worker) => worker.id),
      },
      freshness: getFreshness(signalFreshness, ['workers', 'enrollment']),
      blocksReadiness: true,
      blocksCloseout: false,
    });
  }

  for (const [index, warning] of (systemHealth?.warnings || []).entries()) {
    const critical = isCriticalSystemWarning(warning);
    const source = isFaceServiceWarning(warning) ? 'service' : 'kiosk';
    actions.push({
      key: `system-health-${index}`,
      priority: critical ? CRITICAL_PRIORITY : WARNING_PRIORITY,
      severity: critical ? 'critical' : 'warning',
      label: source === 'service' ? 'Face service warning' : 'Kiosk sync warning',
      value: '!',
      description: warning,
      href: source === 'service' ? '/enroll' : '/kiosks',
      cta: source === 'service' ? 'Review face service' : 'Open kiosks',
      source,
      evidence: {
        warning,
        kioskCounts: systemHealth?.kiosks?.counts || null,
        checkedAt: systemHealth?.checked_at || null,
      },
      freshness: getFreshness(signalFreshness, ['system-health', source]),
      blocksReadiness: true,
      blocksCloseout: source === 'kiosk',
    });
  }

  if (stats.scheduleWarning) {
    actions.push({
      key: 'schedule-warning',
      priority: WARNING_PRIORITY,
      severity: 'warning',
      label: 'Schedule warning',
      value: '!',
      description: stats.scheduleWarning,
      href: '/schedules',
      cta: 'Review now',
      source: 'schedule',
      evidence: {
        scheduleWarning: stats.scheduleWarning,
      },
      freshness: getFreshness(signalFreshness, ['stats', 'schedule']),
      blocksReadiness: true,
      blocksCloseout: false,
    });
  }

  if (shiftExceptions?.backend_unavailable) {
    actions.push({
      key: 'shift-exceptions-unavailable',
      priority: WARNING_PRIORITY,
      severity: 'warning',
      label: 'Shift exception storage unavailable',
      value: '!',
      description: shiftExceptions.warning || 'Shift exceptions are waiting for backend storage, so today cannot be treated as all clear yet.',
      href: buildHref('/exceptions', { date: actionDate, status: 'open' }),
      cta: 'Open exceptions',
      source: 'exceptions',
      evidence: {
        signal: 'shift-exceptions',
        backendUnavailable: true,
        warning: shiftExceptions.warning || null,
        date: shiftExceptions.date || null,
      },
      freshness: getFreshness(signalFreshness, ['shift-exceptions', 'exceptions'], {
        status: 'stale',
        reason: 'signal-unavailable',
        failed: true,
        current: true,
        unavailable: true,
        message: shiftExceptions.warning || null,
      }),
      blocksReadiness: false,
      blocksCloseout: true,
    });
  }

  const openExceptions = getOpenExceptionCount(shiftExceptions);
  if (openExceptions > 0) {
    const criticalExceptions = getCriticalExceptionCount(shiftExceptions);
    const missingClockOuts = getOpenExceptionTypeCount(shiftExceptions, 'missing_clock_out');
    const recognitionReviews = getOpenExceptionTypeCount(shiftExceptions, 'recognition_review');
    const firstMissingClockOutKey = getFirstOpenExceptionKey(shiftExceptions, 'missing_clock_out');
    const firstRecognitionReviewKey = getFirstOpenExceptionKey(shiftExceptions, 'recognition_review');
    const missingClockOutKeys = getOpenExceptionTypeKeys(shiftExceptions, 'missing_clock_out');
    const recognitionReviewKeys = getOpenExceptionTypeKeys(shiftExceptions, 'recognition_review');
    const openExceptionKeys = getOpenExceptionKeys(shiftExceptions);
    const criticalExceptionKeys = getOpenCriticalExceptionKeys(shiftExceptions);
    const priority = criticalExceptions > 0 ? CRITICAL_PRIORITY : WARNING_PRIORITY;
    if (missingClockOuts > 0) {
      actions.push({
        key: 'missing-clock-outs',
        priority: WARNING_PRIORITY,
        severity: 'warning',
        label: 'Clock-out follow-up',
        value: missingClockOuts,
        description: `${plural(missingClockOuts, 'worker')} ${verb(missingClockOuts, 'is', 'are')} still clocked in after the scheduled shift end.`,
        href: buildHref('/exceptions', {
          date: actionDate,
          status: 'open',
          type: 'missing_clock_out',
          exception_key: firstMissingClockOutKey,
          intent: firstMissingClockOutKey ? 'correct' : undefined,
        }),
        cta: 'Review clock-outs',
        source: 'exceptions',
        evidence: {
          type: 'missing_clock_out',
          count: missingClockOuts,
          firstExceptionKey: firstMissingClockOutKey,
          matchingExceptionKeys: missingClockOutKeys,
          byType: shiftExceptions?.summary?.by_type || null,
        },
        freshness: getFreshness(signalFreshness, ['shift-exceptions', 'exceptions']),
        blocksReadiness: false,
        blocksCloseout: true,
      });
    }

    if (recognitionReviews > 0) {
      actions.push({
        key: 'recognition-review',
        priority: WARNING_PRIORITY,
        severity: 'warning',
        label: 'Recognition review',
        value: recognitionReviews,
        description: `${plural(recognitionReviews, 'recognition exception')} ${verb(recognitionReviews, 'needs', 'need')} supervisor review before closeout.`,
        href: buildHref('/exceptions', {
          date: actionDate,
          status: 'open',
          type: 'recognition_review',
          exception_key: firstRecognitionReviewKey,
        }),
        cta: 'Review recognition',
        source: 'exceptions',
        evidence: {
          type: 'recognition_review',
          count: recognitionReviews,
          firstExceptionKey: firstRecognitionReviewKey,
          matchingExceptionKeys: recognitionReviewKeys,
          byType: shiftExceptions?.summary?.by_type || null,
        },
        freshness: getFreshness(signalFreshness, ['shift-exceptions', 'exceptions']),
        blocksReadiness: false,
        blocksCloseout: true,
      });
    }

    actions.push({
      key: 'shift-exceptions',
      priority,
      severity: priority === CRITICAL_PRIORITY ? 'critical' : 'warning',
      label: 'Open shift exceptions',
      value: openExceptions,
      description: `${plural(openExceptions, 'exception')} ${verb(openExceptions, 'needs', 'need')} supervisor review, including ${criticalExceptions} critical.`,
      href: buildHref('/exceptions', {
        date: actionDate,
        status: 'open',
        severity: criticalExceptions > 0 ? 'critical' : undefined,
      }),
      cta: 'Open exceptions',
      source: 'exceptions',
      evidence: {
        date: shiftExceptions?.date || actionDate,
        open: openExceptions,
        critical: criticalExceptions,
        warning: Number(shiftExceptions?.summary?.warning || 0),
        info: Number(shiftExceptions?.summary?.info || 0),
        openExceptionKeys,
        criticalExceptionKeys,
      },
      freshness: getFreshness(signalFreshness, ['shift-exceptions', 'exceptions']),
      blocksReadiness: criticalExceptions > 0,
      blocksCloseout: true,
    });
  }

  if (hasOwn(input, 'shiftCloseout')) {
    if (shiftCloseout?.backend_unavailable) {
      actions.push({
        key: 'shift-closeout-unavailable',
        priority: WARNING_PRIORITY,
        severity: 'warning',
        label: 'Shift closeout storage unavailable',
        value: '!',
        description: shiftCloseout.warning || 'Shift closeout is waiting for backend storage, so the signoff state cannot be trusted yet.',
        href: buildHref('/closeout', { date: actionDate }),
        cta: 'Open closeout',
        source: 'closeout',
        evidence: {
          signal: 'shift-closeout',
          backendUnavailable: true,
          warning: shiftCloseout.warning || null,
          date: shiftCloseout.date || null,
        },
        freshness: getFreshness(signalFreshness, ['shift-closeout', 'closeout'], {
          status: 'stale',
          reason: 'signal-unavailable',
          failed: true,
          current: true,
          unavailable: true,
          message: shiftCloseout.warning || null,
        }),
        blocksReadiness: false,
        blocksCloseout: true,
      });
    }

    if (shiftCloseout?.closeout?.status === 'completed') {
      actions.push({
        key: 'shift-closeout-complete',
        priority: INFO_PRIORITY,
        severity: 'info',
        label: 'Shift closeout complete',
        value: '✓',
        description: `Today's supervisor closeout was completed${shiftCloseout.closeout.completed_at ? ` at ${formatFactoryLocalDateTime(shiftCloseout.closeout.completed_at, '', { hour: '2-digit', minute: '2-digit' })}` : ''}.`,
        href: buildHref('/closeout', { date: actionDate }),
        cta: 'Open closeout',
        source: 'closeout',
        evidence: {
          status: shiftCloseout.closeout.status,
          completedAt: shiftCloseout.closeout.completed_at || null,
        },
        freshness: getFreshness(signalFreshness, ['shift-closeout', 'closeout']),
        blocksReadiness: false,
        blocksCloseout: false,
      });
    } else {
      const blockerCount = shiftCloseout?.blockers?.length || 0;
      const firstBlocker = shiftCloseout?.blockers?.[0] || null;
      const firstBlockerLabel = firstBlocker?.label || null;
      actions.push({
        key: 'shift-closeout-pending',
        priority: CLOSEOUT_PRIORITY,
        severity: blockerCount > 0 ? 'warning' : 'info',
        label: 'Shift closeout pending',
        value: blockerCount || '!',
        description: blockerCount > 0
          ? getCloseoutBlockerDescription(blockerCount, firstBlockerLabel)
          : 'Complete the supervisor closeout when the shift is ready to sign off.',
        href: buildHref('/closeout', { date: actionDate }),
        cta: 'Close shift',
        source: 'closeout',
        evidence: {
          blockerCount,
          canComplete: Boolean(shiftCloseout?.can_complete),
          firstBlockerLabel,
          firstBlockerProof: firstBlocker?.proof || null,
          summary: shiftCloseout?.summary || null,
        },
        freshness: getFreshness(signalFreshness, ['shift-closeout', 'closeout']),
        blocksReadiness: false,
        blocksCloseout: blockerCount > 0,
      });
    }
  }

  const absentWorkers = workers.filter((worker) => worker.status === 'absent');
  const rosterBackedNotArrived = workers.length > 0;
  const notArrived = rosterBackedNotArrived ? absentWorkers.length : Number(stats.notArrived || 0);
  if (notArrived > 0) {
    actions.push({
      key: 'not-arrived',
      priority: INFO_PRIORITY,
      severity: 'info',
      label: 'Not arrived today',
      value: notArrived,
      description: rosterBackedNotArrived
        ? `${plural(notArrived, 'active worker')} ${verb(notArrived, 'has', 'have')} no clock-in scans today.`
        : `${plural(notArrived, 'missing arrival')} ${verb(notArrived, 'is', 'are')} reported from attendance stats today.`,
      href: buildHref('/briefing', { date: actionDate, status: 'missing' }),
      cta: 'Review missing',
      source: 'attendance',
      evidence: {
        count: notArrived,
        workerIds: absentWorkers.map((worker) => worker.id),
      },
      freshness: getFreshness(signalFreshness, ['attendance']),
      blocksReadiness: false,
      blocksCloseout: false,
    });
  }

  return applyRoleActionability(rankProactiveActions(actions), input.currentRole, actionDate);
}
