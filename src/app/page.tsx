'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import WorkerCard from '@/components/WorkerCard';
import { DashboardSkeleton } from '@/components/Skeleton';
import { getFactoryLocalDateString } from '@/lib/date';
import { buildLiveShiftSentinelItems, buildProactiveActions, getLiveShiftSentinelSnapshot } from '@/lib/proactive-actions';
import type { LiveShiftSentinelItem, LiveShiftSentinelSnapshot, ProactiveActionFreshness, ProactiveSignalFreshness } from '@/lib/proactive-actions';
import type { ShiftBriefingResponse, ShiftCloseoutResponse, ShiftException, ShiftExceptionsResponse, ShiftTrustBriefStatus } from '@/lib/types';
import { usePortalRole } from '@/hooks/usePortalRole';

interface WorkerWithStatus {
  id: string;
  name: string;
  department: string;
  has_face_encoding?: boolean;
  encoding_status?: 'valid' | 'missing' | 'invalid';
  status: 'in' | 'out' | 'absent';
  clockInTime?: string;
}

type DashboardWorkerPayload = {
  id: string;
  name: string;
  department: string;
  has_face_encoding?: boolean;
  encoding_status?: 'valid' | 'missing' | 'invalid';
};

interface AttendanceEvent {
  id?: string;
  worker_id: string;
  worker_name?: string;
  worker_department?: string;
  event_type: 'clock_in' | 'clock_out' | string;
  timestamp: string;
  kiosk_id?: string | null;
  kiosk_name?: string | null;
}

type OpsReadinessStatus = 'ready' | 'attention' | 'critical';

interface RecentEvent {
  id: string;
  tone: 'emerald' | 'amber' | 'red' | 'slate';
  source: 'system-warning' | 'attendance';
  label: string;
  title: string;
  description: string;
  timestamp: string | null;
  href: string;
}

type HealthStatus = 'online' | 'degraded' | 'stale' | 'offline' | 'never_synced';

interface KioskHealthRow {
  id: string;
  name: string;
  kiosk_id: string | null;
  type: string;
  location: string;
  last_sync: string | null;
  status: 'online' | 'stale' | 'offline' | 'never_synced';
  expected_worker_count: number;
  last_attendance_upload: string | null;
  device_issues?: string[];
}

interface SystemHealth {
  checked_at: string;
  portal: { status: 'online'; checked_at: string };
  face_service: {
    status: 'online' | 'degraded' | 'offline';
    latency_ms: number;
    version: string | null;
    model_ready: boolean;
  };
  kiosks: {
    total: number;
    counts: { online: number; stale: number; offline: number; never_synced: number };
    rows: KioskHealthRow[];
  };
  sync: { ready_worker_count: number; last_attendance_upload: string | null };
  warnings: string[];
}

type SignalFailureKey = 'stats' | 'workers' | 'attendance' | 'system-health' | 'shift-briefing' | 'shift-exceptions' | 'shift-closeout';
type SignalFreshnessMap = Partial<Record<SignalFailureKey, ProactiveSignalFreshness>>;

const SENTINEL_SEEN_STORAGE_KEY = 'fw-gatekeeper:live-shift-sentinel:v1:seen';

interface SignalFailure {
  key: SignalFailureKey;
  label: string;
  href: string;
  message: string;
}

function formatRelativeTime(value: string | null) {
  if (!value) return 'Never';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown';
  const diffMs = Date.now() - timestamp;
  if (diffMs < -60_000) return 'Clock skew';
  if (diffMs < 60_000) return 'Just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function healthTone(status: HealthStatus) {
  return {
    online: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
    degraded: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
    stale: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
    offline: 'border-red-400/20 bg-red-400/10 text-red-300',
    never_synced: 'border-red-400/20 bg-red-400/10 text-red-300',
  }[status];
}

function healthLabel(status: HealthStatus) {
  return status === 'never_synced' ? 'Never synced' : status.charAt(0).toUpperCase() + status.slice(1);
}

function signalErrorMessage(label: string, error: unknown) {
  const detail = error instanceof Error ? error.message : 'Request failed';
  return `${label} could not refresh: ${detail}`;
}

function isFaceServiceWarning(warning: string) {
  return warning.toLowerCase().includes('face service');
}

function isCriticalSystemWarning(warning: string) {
  const normalized = warning.toLowerCase();
  return (
    normalized.includes('offline') ||
    normalized.includes('never synced') ||
    normalized.includes('not ready') ||
    normalized.includes('unavailable')
  );
}

function formatFreshnessTime(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function isSignalStale(freshness: SignalFreshnessMap, key: SignalFailureKey) {
  const signal = freshness[key];
  return Boolean(signal?.failed || signal?.unavailable);
}

function getSignalFreshnessCopy(freshness: SignalFreshnessMap, key: SignalFailureKey, fallback: string) {
  const signal = freshness[key];
  if (!signal?.failed && !signal?.unavailable) return null;
  const lastSuccess = formatFreshnessTime(signal.lastSuccessAt);
  return lastSuccess ? `${fallback} from ${lastSuccess}` : `${fallback}; no confirmed refresh`;
}

function titleCase(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function buildHref(path: string, params: Record<string, string | number | null | undefined>) {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `${path}?${query}` : path;
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

function isCorrectionResolution(action: ShiftException['suggested_resolution']['action']) {
  return action === 'add_clock_in' || action === 'add_clock_out' || action === 'void_event';
}

function getExceptionTypeLabel(type: string) {
  const labels: Record<string, string> = {
    missing_arrival: 'Missing arrival',
    late_arrival: 'Late arrival',
    missing_clock_out: 'Still clocked in',
    scan_sequence: 'Bad scan sequence',
    recognition_review: 'Recognition review',
  };
  return labels[type] || titleCase(type);
}

function getExceptionHref(exception: ShiftException, canOperate: boolean) {
  const resolution = exception.suggested_resolution;
  const shouldOpenCorrectionIntent = canOperate && resolution.can_apply && isCorrectionResolution(resolution.action);
  if (canOperate && resolution.href && !shouldOpenCorrectionIntent) {
    return resolution.href;
  }

  return buildHref('/exceptions', {
    date: exception.date,
    status: 'open',
    department: exception.department || undefined,
    type: exception.type,
    severity: exception.severity,
    exception_key: exception.key,
    intent: shouldOpenCorrectionIntent
      ? 'correct'
      : undefined,
  });
}

function getExceptionSourceHref(exception: ShiftException) {
  return exception.suggested_resolution.source_href ||
    exception.suggested_resolution.href ||
    exception.links.activity_log ||
    exception.links.recognition_lab ||
    exception.links.kiosk ||
    null;
}

function getRoleSafeExceptionSourceHref(exception: ShiftException, canOperate: boolean) {
  const href = getExceptionSourceHref(exception);
  return href && !canOperate ? stripHrefParams(href, ['intent']) : href;
}

function getTrustTone(status: ShiftTrustBriefStatus | OpsReadinessStatus | null) {
  if (status === 'ready') return 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200';
  if (status === 'blocked' || status === 'critical') return 'border-red-400/25 bg-red-400/10 text-red-200';
  return 'border-amber-400/25 bg-amber-400/10 text-amber-200';
}

function getTrustLabel(status: ShiftTrustBriefStatus | OpsReadinessStatus | null) {
  if (status === 'blocked' || status === 'critical') return 'Blocked';
  if (status === 'ready') return 'Ready';
  return 'Needs attention';
}

function parseSentinelState(value: string | null): { snapshot: LiveShiftSentinelSnapshot; hasFullBaseline: boolean } {
  if (!value) return { snapshot: {}, hasFullBaseline: false };
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { snapshot: {}, hasFullBaseline: false };
    if ('snapshot' in parsed && parsed.snapshot && typeof parsed.snapshot === 'object' && !Array.isArray(parsed.snapshot)) {
      return {
        snapshot: Object.fromEntries(
          Object.entries(parsed.snapshot).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        ),
        hasFullBaseline: parsed.hasFullBaseline === true,
      };
    }
    return {
      snapshot: Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ),
      hasFullBaseline: false,
    };
  } catch {
    return { snapshot: {}, hasFullBaseline: false };
  }
}

function writeSentinelState(snapshot: LiveShiftSentinelSnapshot, hasFullBaseline: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SENTINEL_SEEN_STORAGE_KEY, JSON.stringify({ snapshot, hasFullBaseline }));
  } catch {
    // Sentinel seen state is optional client-local UI state.
  }
}

function readSentinelState() {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(SENTINEL_SEEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getSentinelStatusLabel(item: LiveShiftSentinelItem) {
  if (item.status === 'new') return 'New since seen';
  if (item.status === 'changed') return 'Changed since seen';
  if (item.status === 'seen') return 'Seen';
  return 'Current risk';
}

function getSentinelStatusTone(item: LiveShiftSentinelItem) {
  if (item.status === 'seen') return 'border-slate-400/15 bg-slate-400/5 text-slate-300';
  if (item.status === 'new' || item.status === 'changed') return 'border-gold/25 bg-gold/10 text-gold';
  return item.priority === 'critical'
    ? 'border-red-400/20 bg-red-400/10 text-red-300'
    : 'border-amber-400/20 bg-amber-400/10 text-amber-300';
}

export default function Dashboard() {
  const currentRole = usePortalRole();
  const [stats, setStats] = useState({ totalWorkers: 0, clockedIn: 0, clockedOut: 0, notArrived: 0, avgArrival: null as string | null });
  const [workers, setWorkers] = useState<WorkerWithStatus[]>([]);
  const [attendanceEvents, setAttendanceEvents] = useState<AttendanceEvent[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [shiftBriefing, setShiftBriefing] = useState<ShiftBriefingResponse | null>(null);
  const [shiftExceptions, setShiftExceptions] = useState<ShiftExceptionsResponse | null>(null);
  const [shiftCloseout, setShiftCloseout] = useState<ShiftCloseoutResponse | null>(null);
  const [search, setSearch] = useState('');
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [signalFailures, setSignalFailures] = useState<SignalFailure[]>([]);
  const [signalFreshness, setSignalFreshness] = useState<SignalFreshnessMap>({});
  const [sentinelSeenSnapshot, setSentinelSeenSnapshot] = useState<LiveShiftSentinelSnapshot>({});
  const [sentinelHasSeenBaseline, setSentinelHasSeenBaseline] = useState(false);
  const [sentinelStorageReady, setSentinelStorageReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Read by fetchData without being a dependency, so the polling interval
  // isn't torn down and re-armed on every successful refresh.
  const attendanceEventsRef = useRef<AttendanceEvent[]>([]);

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const attemptedAt = new Date();
      const attemptedAtIso = attemptedAt.toISOString();
      const today = getFactoryLocalDateString();
      const signals: Array<{ key: SignalFailureKey; label: string; href: string; request: () => Promise<Response> }> = [
        { key: 'stats', label: 'Dashboard stats', href: `/log?date=${today}`, request: () => fetch(`/api/stats?date=${today}`) },
        { key: 'workers', label: 'Worker roster', href: '/workers', request: () => fetch('/api/workers?scope=dashboard') },
        { key: 'attendance', label: 'Attendance events', href: `/log?date=${today}`, request: () => fetch(`/api/attendance?date=${today}`) },
        { key: 'system-health', label: 'Kiosk and system health', href: '/kiosks', request: () => fetch(`/api/system-health?date=${today}`) },
        { key: 'shift-briefing', label: 'Morning readiness brief', href: `/briefing?date=${today}`, request: () => fetch(`/api/shift-briefing?date=${today}`) },
        { key: 'shift-exceptions', label: 'Shift exceptions', href: `/exceptions?date=${today}&status=open`, request: () => fetch(`/api/shift-exceptions?date=${today}`) },
        { key: 'shift-closeout', label: 'Shift closeout', href: `/closeout?date=${today}`, request: () => fetch(`/api/shift-closeout?date=${today}`) },
      ];

      const results = await Promise.allSettled(signals.map(async (signal) => {
        const res = await signal.request();
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(json?.error || `${res.status} ${res.statusText}`);
        }
        return { signal, json };
      }));

      const failures: SignalFailure[] = [];
      const successfulKeys = new Set<SignalFailureKey>();
      let nextWorkers: DashboardWorkerPayload[] | null = null;
      let nextAttendance: AttendanceEvent[] | null = null;

      results.forEach((result, index) => {
        const signal = signals[index];
        if (result.status === 'rejected') {
          failures.push({
            key: signal.key,
            label: signal.label,
            href: signal.href,
            message: signalErrorMessage(signal.label, result.reason),
          });
          return;
        }

        const { json } = result.value;
        if (signal.key === 'stats') {
          successfulKeys.add(signal.key);
          setStats(json);
        } else if (signal.key === 'workers') {
          successfulKeys.add(signal.key);
          nextWorkers = Array.isArray(json) ? json : [];
        } else if (signal.key === 'attendance') {
          successfulKeys.add(signal.key);
          nextAttendance = Array.isArray(json) ? json : [];
          attendanceEventsRef.current = nextAttendance;
          setAttendanceEvents(nextAttendance);
        } else if (signal.key === 'system-health') {
          successfulKeys.add(signal.key);
          setSystemHealth(json);
        } else if (signal.key === 'shift-briefing') {
          setShiftBriefing(json);
          if (json?.backend_unavailable) {
            failures.push({
              key: signal.key,
              label: signal.label,
              href: signal.href,
              message: json.warning || 'Morning readiness brief is unavailable while shift briefing storage catches up.',
            });
          } else {
            successfulKeys.add(signal.key);
          }
        } else if (signal.key === 'shift-exceptions') {
          successfulKeys.add(signal.key);
          setShiftExceptions(json);
        } else if (signal.key === 'shift-closeout') {
          successfulKeys.add(signal.key);
          setShiftCloseout(json);
        }
      });

      const statusMap = new Map<string, { event_type: string; timestamp: string }>();
      const attendanceForRoster = nextAttendance || attendanceEventsRef.current;
      for (const e of attendanceForRoster) {
        const existing = statusMap.get(e.worker_id);
        if (!existing || e.timestamp > existing.timestamp) {
          statusMap.set(e.worker_id, { event_type: e.event_type, timestamp: e.timestamp });
        }
      }

      const workersForRoster = nextWorkers as DashboardWorkerPayload[] | null;
      if (workersForRoster) {
        const enriched: WorkerWithStatus[] = workersForRoster.map((w) => {
          const latest = statusMap.get(w.id);
          let status: 'in' | 'out' | 'absent' = 'absent';
          let clockInTime: string | undefined;

          if (latest) {
            status = latest.event_type === 'clock_in' ? 'in' : 'out';
            clockInTime = new Date(latest.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          }

          return { ...w, status, clockInTime };
        });

        enriched.sort((a, b) => {
          const order = { in: 0, out: 1, absent: 2 };
          return order[a.status] - order[b.status];
        });

        setWorkers(enriched);
      }
      setSignalFailures(failures);
      setSignalFreshness((previous) => {
        const next: SignalFreshnessMap = { ...previous };
        for (const signal of signals) {
          const failure = failures.find((item) => item.key === signal.key);
          if (failure) {
            next[signal.key] = {
              ...next[signal.key],
              failed: true,
              current: true,
              unavailable: true,
              message: failure.message,
            };
          } else if (successfulKeys.has(signal.key)) {
            next[signal.key] = {
              lastSuccessAt: attemptedAtIso,
              failed: false,
              current: true,
              unavailable: false,
              message: null,
            };
          }
        }
        return next;
      });
      setLastUpdated(attemptedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } catch (err) {
      console.error('Failed to fetch dashboard data', err);
      const failedAt = new Date().toISOString();
      setSignalFailures([{
        key: 'stats',
        label: 'Dashboard refresh',
        href: '/',
        message: signalErrorMessage('Dashboard refresh', err),
      }]);
      setSignalFreshness((previous) => ({
        ...previous,
        stats: {
          ...previous.stats,
          failed: true,
          current: true,
          unavailable: true,
          message: signalErrorMessage('Dashboard refresh', err),
        },
      }));
      setLastUpdated(new Date(failedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const storedSentinel = parseSentinelState(readSentinelState());
    setSentinelSeenSnapshot(storedSentinel.snapshot);
    setSentinelHasSeenBaseline(storedSentinel.hasFullBaseline);
    setSentinelStorageReady(true);
  }, []);

  useEffect(() => {
    fetchData();
    // Skip refreshes while the tab is hidden; catch up as soon as it returns.
    const interval = setInterval(() => {
      if (!document.hidden) fetchData(true);
    }, 10000);
    const onVisibilityChange = () => {
      if (!document.hidden) fetchData(true);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchData]);

  const actionDate = getFactoryLocalDateString();
  const dashboardRole = currentRole || 'viewer';
  const proactiveShiftCloseout = shiftCloseout
    ? {
        ...shiftCloseout,
        summary: { ...shiftCloseout.summary },
      }
    : null;
  const actionItems = buildProactiveActions({
    date: actionDate,
    signalFailures,
    signalFreshness,
    workers,
    systemHealth,
    stats,
    shiftExceptions,
    shiftCloseout: proactiveShiftCloseout,
    currentRole: dashboardRole,
  });
  const sentinelItems = buildLiveShiftSentinelItems(actionItems, {
    seenSnapshot: sentinelSeenSnapshot,
    hasSeenBaseline: sentinelStorageReady && sentinelHasSeenBaseline,
  });
  const activeSentinelKeySignature = sentinelItems.map((item) => item.key).sort().join('|');

  useEffect(() => {
    if (loading || !sentinelStorageReady) return;
    const activeKeys = new Set(activeSentinelKeySignature ? activeSentinelKeySignature.split('|') : []);
    setSentinelSeenSnapshot((previous) => {
      if (!activeSentinelKeySignature && Object.keys(previous).length === 0) return previous;
      const next = Object.fromEntries(Object.entries(previous).filter(([key]) => activeKeys.has(key)));
      if (Object.keys(next).length === Object.keys(previous).length) return previous;
      writeSentinelState(next, sentinelHasSeenBaseline);
      return next;
    });
  }, [activeSentinelKeySignature, loading, sentinelHasSeenBaseline, sentinelStorageReady]);

  if (loading) {
    return <DashboardSkeleton />;
  }

  const filtered = workers.filter(
    (w) =>
      w.name.toLowerCase().includes(search.toLowerCase()) ||
      w.department.toLowerCase().includes(search.toLowerCase())
  );
  const missingFaceWorkers = workers.filter((w) => w.encoding_status === 'missing' || (!w.encoding_status && !w.has_face_encoding));
  const invalidFaceWorkers = workers.filter((w) => w.encoding_status === 'invalid');
  const failedSignalKeys = new Set(signalFailures.map((failure) => failure.key));
  const staleSignalSummaries = [
    getSignalFreshnessCopy(signalFreshness, 'stats', 'Stats cached'),
    getSignalFreshnessCopy(signalFreshness, 'workers', 'Roster cached'),
    getSignalFreshnessCopy(signalFreshness, 'attendance', 'Attendance cached'),
    getSignalFreshnessCopy(signalFreshness, 'system-health', 'System health cached'),
    getSignalFreshnessCopy(signalFreshness, 'shift-briefing', 'Morning brief cached'),
    getSignalFreshnessCopy(signalFreshness, 'shift-exceptions', 'Exceptions cached'),
    getSignalFreshnessCopy(signalFreshness, 'shift-closeout', 'Closeout cached'),
  ].filter((item): item is string => Boolean(item));
  const rosterStaleCopy = getSignalFreshnessCopy(signalFreshness, 'workers', 'Roster cached');
  const attendanceStaleCopy = getSignalFreshnessCopy(signalFreshness, 'attendance', 'Attendance status cached');
  const workerCardFreshnessCopy = attendanceStaleCopy || rosterStaleCopy;
  const workerCardsAreStale = isSignalStale(signalFreshness, 'workers') || isSignalStale(signalFreshness, 'attendance');
  const systemHealthStaleCopy = getSignalFreshnessCopy(signalFreshness, 'system-health', 'System health cached');
  const sentinelChangedCount = sentinelItems.filter((item) => item.changedSinceSeen).length;
  const sentinelCriticalCount = sentinelItems.filter((item) => item.priority === 'critical').length;
  const canOpenAdminOps = dashboardRole === 'admin';
  const canOpenEnrollmentOps = dashboardRole === 'admin' || dashboardRole === 'enrollment';
  const canOperateExceptionWork = dashboardRole === 'admin' || dashboardRole === 'enrollment';
  const opsKioskHref = canOpenAdminOps ? '/kiosks' : `/briefing?date=${actionDate}`;
  const morningBriefHref = `/briefing?date=${actionDate}`;
  const opsEnrollmentHref = canOpenEnrollmentOps ? '/enroll' : `/briefing?date=${actionDate}`;
  const opsExceptionsHref = `/exceptions?date=${actionDate}&status=open`;
  const systemHealthCta = canOpenAdminOps ? 'Manage kiosks' : 'Review readiness';
  const rosterFailureHref = canOpenAdminOps ? '/workers' : `/briefing?date=${actionDate}`;
  const signalFailureHrefs: Partial<Record<SignalFailureKey, string>> = {
    workers: rosterFailureHref,
    'system-health': opsKioskHref,
    'shift-briefing': morningBriefHref,
  };

  const offlineKioskCount = systemHealth
    ? systemHealth.kiosks.counts.offline + systemHealth.kiosks.counts.never_synced
    : 0;
  const staleKioskCount = systemHealth?.kiosks.counts.stale || 0;
  const faceServiceHealthy = systemHealth?.face_service.status === 'online' && systemHealth.face_service.model_ready;
  const hasWorkerEnrollmentIssues = missingFaceWorkers.length + invalidFaceWorkers.length > 0;
  const readyForShift = Boolean(
    systemHealth &&
    faceServiceHealthy &&
    systemHealth.kiosks.total > 0 &&
    offlineKioskCount === 0 &&
    staleKioskCount === 0 &&
    !hasWorkerEnrollmentIssues
  );
  const readinessStatus: OpsReadinessStatus = !systemHealth || systemHealth.kiosks.total === 0 || stats.totalWorkers === 0 || offlineKioskCount > 0 || !faceServiceHealthy
    ? 'critical'
    : readyForShift
      ? 'ready'
      : 'attention';
  const readinessCopy = {
    ready: {
      label: 'Ready for shift',
      description: 'Portal, face service, kiosk sync, and worker enrollment are all healthy.',
      tone: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200',
    },
    attention: {
      label: 'Needs attention before shift',
      description: 'Core services are reachable, but at least one readiness check needs review.',
      tone: 'border-amber-400/25 bg-amber-400/10 text-amber-200',
    },
    critical: {
      label: 'Not ready for shift',
      description: !systemHealth
        ? 'System health is unavailable, so readiness cannot be confirmed.'
        : systemHealth.kiosks.total === 0
          ? 'No kiosks are registered, so employee clock-in cannot be confirmed.'
          : stats.totalWorkers === 0
            ? 'No active workers are available for today’s clock-in readiness.'
            : offlineKioskCount > 0
              ? `${offlineKioskCount} kiosk${offlineKioskCount === 1 ? '' : 's'} are offline or have never synced.`
              : 'Face service is not fully ready for enrollment or recognition.',
      tone: 'border-red-400/25 bg-red-400/10 text-red-200',
    },
  }[readinessStatus];

  const recentEvents: RecentEvent[] = [
    ...(systemHealth?.warnings || []).map((warning, index) => {
      const faceServiceWarning = isFaceServiceWarning(warning);
      return {
        id: `warning-${index}`,
        tone: isCriticalSystemWarning(warning) ? 'red' as const : 'amber' as const,
        source: 'system-warning' as const,
        label: faceServiceWarning ? 'System warning' : 'Kiosk timeline signal',
        title: faceServiceWarning ? 'Face service needs attention' : 'Kiosk sync needs attention',
        description: warning,
        timestamp: systemHealth?.checked_at || null,
        href: faceServiceWarning ? opsEnrollmentHref : opsKioskHref,
      };
    }),
    ...attendanceEvents.map((event) => ({
      id: event.id || `${event.worker_id}-${event.timestamp}-${event.event_type}`,
      tone: event.event_type === 'clock_in' ? 'emerald' as const : 'slate' as const,
      source: 'attendance' as const,
      label: event.event_type === 'clock_in' ? 'Clock in' : event.event_type === 'clock_out' ? 'Clock out' : 'Attendance',
      title: `${event.worker_name || 'Worker'} ${event.event_type === 'clock_in' ? 'clocked in' : event.event_type === 'clock_out' ? 'clocked out' : 'recorded an event'}`,
      description: `${event.worker_department || 'No department'}${event.kiosk_name ? ` · ${event.kiosk_name}` : event.kiosk_id ? ` · ${event.kiosk_id}` : ''}`,
      timestamp: event.timestamp,
      href: `/log?date=${actionDate}`,
    })),
  ]
    .sort((a, b) => {
      const bMs = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      const aMs = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
    })
    .slice(0, 8);

  const trustBrief = shiftBriefing && !shiftBriefing.backend_unavailable ? shiftBriefing.shift_trust_brief : null;
  const trustStatus = trustBrief?.readiness_status || readinessStatus;
  const trustSummary = trustBrief?.summary_sentence || readinessCopy.description;
  const trustFreshnessCopy = getSignalFreshnessCopy(signalFreshness, 'shift-briefing', 'Morning brief cached');
  const exceptionSignalUnavailable = isSignalStale(signalFreshness, 'shift-exceptions') ||
    Boolean(shiftExceptions?.backend_unavailable) ||
    !shiftExceptions;
  const exceptionUnavailableCopy = getSignalFreshnessCopy(signalFreshness, 'shift-exceptions', 'Exceptions cached') ||
    shiftExceptions?.warning ||
    'Shift exceptions are unavailable, so exception work cannot be treated as clear yet.';
  const openExceptionMetric = exceptionSignalUnavailable
    ? '—'
    : trustBrief?.source_counts.open_exceptions ?? shiftExceptions.summary.open;
  const openExceptionMetricLabel = exceptionSignalUnavailable ? 'queue unavailable' : 'need disposition';
  const closeoutSignalUnavailable = isSignalStale(signalFreshness, 'shift-closeout') ||
    Boolean(shiftCloseout?.backend_unavailable) ||
    !shiftCloseout;
  const closeoutRiskMetric = closeoutSignalUnavailable && !trustBrief
    ? '—'
    : trustBrief?.closeout_risks.length ?? shiftCloseout?.blockers.length ?? 0;
  const closeoutRiskMetricLabel = closeoutSignalUnavailable && !trustBrief ? 'closeout unavailable' : 'blockers / risks';
  const openExceptionRows = (shiftExceptions?.exceptions || [])
    .filter((exception) => exception.status === 'open')
    .slice(0, 4);

  function markSentinelSeen(items: LiveShiftSentinelItem[], establishBaseline = false) {
    const next = {
      ...sentinelSeenSnapshot,
      ...getLiveShiftSentinelSnapshot(items),
    };
    const coversCurrentSentinel = sentinelItems.length > 0 && sentinelItems.every((item) => Boolean(next[item.key]));
    const nextHasFullBaseline = sentinelHasSeenBaseline || establishBaseline || coversCurrentSentinel;
    setSentinelSeenSnapshot(next);
    setSentinelHasSeenBaseline(nextHasFullBaseline);
    writeSentinelState(next, nextHasFullBaseline);
  }

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="page-title text-slate-100">
            Shift Command <span className="text-gold">Inbox</span>
          </h1>
          <div className="flex items-center gap-3 mt-2">
            <span className="flex items-center gap-1.5">
              <span className={`status-dot bg-emerald-400 ${refreshing ? 'refresh-pulse' : 'animate-pulse-slow'}`} />
              <span className="text-xs font-mono text-slate-500">
                {refreshing ? 'Syncing...' : signalFailures.length > 0 ? 'Partial live data' : 'Live'}
              </span>
            </span>
            {lastUpdated && (
              <span className="text-xs font-mono text-slate-600">Refresh attempted {lastUpdated}</span>
            )}
            {stats.avgArrival && (
              <span className="text-xs font-mono text-slate-600">Avg arrival {stats.avgArrival}</span>
            )}
          </div>
        </div>
      </div>

      {signalFailures.length > 0 && (
        <section role="status" className="rounded-2xl border border-amber-400/25 bg-amber-400/5 p-4 mb-6">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
            <div>
              <p className="section-label text-amber-200">Live data gaps</p>
              <h2 className="mt-1 font-display text-lg font-semibold text-amber-100">Some dashboard signals did not refresh</h2>
              <p className="mt-1 text-sm text-amber-100/75 leading-6">
                The rest of the dashboard is using the latest successful data. Review the affected source before treating this as all clear.
              </p>
              {staleSignalSummaries.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {staleSignalSummaries.map((summary) => (
                    <span key={summary} className="badge border border-amber-400/20 bg-amber-400/10 text-[10px] text-amber-200">{summary}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:min-w-[520px]">
              {signalFailures.map((failure) => (
                <Link key={failure.key} href={signalFailureHrefs[failure.key] || failure.href} className="rounded-xl border border-amber-400/20 bg-navy-950/35 px-3 py-2 text-sm text-amber-100 hover:border-gold/35 transition-colors">
                  <span className="block font-display font-semibold">{failure.label}</span>
                  <span className="mt-1 block text-xs leading-5 text-amber-100/65">{failure.message}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Shift Command Inbox */}
      <section className={`rounded-3xl border p-5 mb-6 ${getTrustTone(trustStatus)}`}>
        <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-5">
          <div className="max-w-2xl">
            <p className="text-xs font-mono uppercase tracking-[0.2em] opacity-80">Action Center</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h2 className="font-display text-2xl font-semibold text-slate-100">{getTrustLabel(trustStatus)} shift trust</h2>
              <span className="badge border border-current/20 bg-black/10 text-current">
                {trustBrief ? titleCase(trustBrief.readiness_status) : readinessCopy.label}
              </span>
              {systemHealthStaleCopy && (
                <span className="badge border border-amber-400/20 bg-amber-400/10 text-amber-200">{systemHealthStaleCopy}</span>
              )}
              {trustFreshnessCopy && (
                <span className="badge border border-amber-400/20 bg-amber-400/10 text-amber-200">{trustFreshnessCopy}</span>
              )}
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-300">{trustSummary}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href={morningBriefHref} className="btn-primary inline-flex px-4 py-2 text-sm">
                Open Morning Readiness Brief
              </Link>
              <Link href={opsExceptionsHref} className="btn-secondary inline-flex px-4 py-2 text-sm">
                Review open exceptions
              </Link>
              <Link href={`/closeout?date=${actionDate}`} className="btn-secondary inline-flex px-4 py-2 text-sm">
                Check closeout
              </Link>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:min-w-[560px] gap-3">
            <div className="rounded-2xl bg-navy-950/35 border border-white/10 p-3">
              <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Expected</p>
              <p className="mt-1 text-2xl font-display font-bold text-slate-100">{trustBrief?.source_counts.expected ?? stats.totalWorkers}</p>
              <p className="text-[11px] text-slate-500">workers today</p>
            </div>
            <div className="rounded-2xl bg-navy-950/35 border border-white/10 p-3">
              <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Open exceptions</p>
              <p className="mt-1 text-2xl font-display font-bold text-gold">{openExceptionMetric}</p>
              <p className="text-[11px] text-slate-500">{openExceptionMetricLabel}</p>
            </div>
            <div className="rounded-2xl bg-navy-950/35 border border-white/10 p-3">
              <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Closeout risks</p>
              <p className="mt-1 text-2xl font-display font-bold text-amber-300">{closeoutRiskMetric}</p>
              <p className="text-[11px] text-slate-500">{closeoutRiskMetricLabel}</p>
            </div>
            <div className="rounded-2xl bg-navy-950/35 border border-white/10 p-3">
              <p className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Kiosks online</p>
              <p className="mt-1 text-2xl font-display font-bold text-slate-100">{systemHealth ? systemHealth.kiosks.counts.online : '—'}</p>
              <p className="text-[11px] text-slate-500">{systemHealth ? `${systemHealth.kiosks.counts.online} of ${systemHealth.kiosks.total} kiosks online` : 'sync unknown'}</p>
            </div>
          </div>
        </div>

        <section className="mt-5 rounded-2xl border border-white/10 bg-navy-950/30 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="section-label text-gold">Live Shift Sentinel</p>
              <h3 className="mt-1 font-display text-lg font-semibold text-slate-100">Urgent live changes and current risk</h3>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                Deterministic watcher from exception, kiosk, closeout, recognition, attendance, and source-availability evidence.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge border border-red-400/15 bg-red-400/5 text-[10px] text-red-300">
                {sentinelCriticalCount} critical
              </span>
              <span className="badge border border-gold/20 bg-gold/10 text-[10px] text-gold">
                {sentinelChangedCount} changed
              </span>
              {sentinelItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => markSentinelSeen(sentinelItems, true)}
                  className="btn-secondary text-xs"
                >
                  Mark Sentinel seen
                </button>
              )}
            </div>
          </div>

          {sentinelItems.length > 0 ? (
            <div className="mt-4 grid gap-3 xl:grid-cols-3">
              {sentinelItems.map((item) => (
                <article key={item.key} className="rounded-xl border border-navy-600/50 bg-navy-900/45 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`badge border text-[10px] ${getSentinelStatusTone(item)}`}>
                          {getSentinelStatusLabel(item)}
                        </span>
                        <span className="badge border border-navy-600/50 bg-navy-900/60 text-[10px] text-slate-400">
                          {item.kind.replace(/-/g, ' ')}
                        </span>
                        {item.freshnessLabel && (
                          <span className="badge border border-amber-400/15 bg-amber-400/5 text-[10px] text-amber-300">
                            {item.freshnessLabel}
                          </span>
                        )}
                        {item.actionability?.access === 'review' && (
                          <span className="badge border border-slate-400/15 bg-slate-400/5 text-[10px] text-slate-300">
                            Review only
                          </span>
                        )}
                      </div>
                      <h4 className="mt-2 font-display text-sm font-semibold text-slate-100">{item.label}</h4>
                      <p className="mt-1 text-xs leading-5 text-slate-400">{item.description}</p>
                    </div>
                  </div>
                  {item.evidenceChips.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2" aria-label={`${item.label} Sentinel evidence`}>
                      {item.evidenceChips.map((chip) => (
                        <span key={chip} className="rounded border border-navy-500/60 bg-navy-950/35 px-2 py-1 text-[10px] font-mono text-slate-400">
                          {chip}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Link href={item.href} className="inline-flex text-xs font-semibold text-gold hover:text-gold-light">
                      {item.cta} →
                    </Link>
                    {item.proofLink && (
                      <Link href={item.proofLink.href} className="inline-flex text-xs font-semibold text-slate-300 hover:text-gold-light">
                        {item.proofLink.label} →
                      </Link>
                    )}
                    {!item.acknowledged && (
                      <button
                        type="button"
                        onClick={() => markSentinelSeen([item])}
                        className="inline-flex text-xs font-semibold text-slate-400 hover:text-slate-200"
                      >
                        Mark seen
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-emerald-400/15 bg-emerald-400/5 p-3 text-sm text-emerald-200">
              No urgent Sentinel items from loaded signals. Source gaps will appear here before the inbox is treated as clear.
            </div>
          )}
        </section>

        {actionItems.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-emerald-400/15 bg-emerald-400/5 p-4 flex items-start gap-3">
            <span className="status-dot-pulse bg-emerald-400 mt-1.5" />
            <div>
              <p className="font-display font-semibold text-emerald-300">All clear</p>
              <p className="text-sm text-slate-500 mt-1">No readiness, kiosk, exception, closeout, enrollment, schedule, or arrival issues need review right now.</p>
            </div>
          </div>
        ) : null}
      </section>

      <section className="glass-card p-5 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <p className="section-label">Open exception work</p>
            <h2 className="mt-1 font-display text-lg font-semibold text-slate-100">Suggested resolutions</h2>
            <p className="mt-1 text-xs text-slate-500 font-mono">
              {exceptionSignalUnavailable ? exceptionUnavailableCopy : `${shiftExceptions.summary.open} open of ${shiftExceptions.summary.total} total exceptions`}
            </p>
          </div>
          <Link href={opsExceptionsHref} className="btn-secondary text-xs">Open full queue</Link>
        </div>
        {exceptionSignalUnavailable ? (
          <div role="status" className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-200">
            {exceptionUnavailableCopy}
          </div>
        ) : openExceptionRows.length > 0 ? (
          <div className="grid gap-3 xl:grid-cols-2">
            {openExceptionRows.map((exception) => {
              const resolution = exception.suggested_resolution;
              const canApplyResolution = canOperateExceptionWork && resolution.can_apply;
              const primaryExceptionCta = canApplyResolution ? resolution.cta : 'Review source';
              const sourceHref = getRoleSafeExceptionSourceHref(exception, canOperateExceptionWork);
              const severityTone = {
                critical: 'border-red-400/20 bg-red-400/10 text-red-300',
                warning: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
                info: 'border-blue-400/20 bg-blue-400/10 text-blue-300',
              }[exception.severity];
              return (
                <article key={exception.key} className="rounded-2xl border border-navy-600/45 bg-navy-900/40 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`badge border ${severityTone}`}>{titleCase(exception.severity)}</span>
                        <span className="badge border border-navy-600/50 bg-navy-900/60 text-slate-400">
                          {getExceptionTypeLabel(exception.type)}
                        </span>
                        {!canOperateExceptionWork && (
                          <span className="badge border border-slate-400/15 bg-slate-400/5 text-[10px] text-slate-300">Review only</span>
                        )}
                      </div>
                      <h3 className="mt-2 font-display text-base font-semibold text-slate-100">{exception.title}</h3>
                      <p className="mt-1 text-sm leading-5 text-slate-400">{exception.description}</p>
                    </div>
                    <span className="text-xs font-mono text-slate-600 shrink-0">{formatRelativeTime(exception.last_seen || exception.first_seen)}</span>
                  </div>
                  <div className="mt-3 rounded-xl border border-navy-600/50 bg-navy-950/45 p-3">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500">Suggested resolution</p>
                    <p className="mt-1 text-sm font-medium text-slate-200">{resolution.label}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">{resolution.disabled_reason || resolution.reason}</p>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <Link href={getExceptionHref(exception, canOperateExceptionWork)} className="inline-flex text-xs font-semibold text-gold hover:text-gold-light">
                      {primaryExceptionCta} →
                    </Link>
                    {sourceHref && (
                      <Link href={sourceHref} className="inline-flex text-xs font-semibold text-slate-300 hover:text-gold-light">
                        Source evidence →
                      </Link>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/5 p-4 text-sm text-emerald-200">
            No open exception rows need supervisor disposition right now.
          </div>
        )}
      </section>

      {/* System Health */}
      <section className="glass-card p-5 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <p className="section-label">System Health</p>
            <h2 className="mt-1 font-display text-lg font-semibold text-slate-100">Kiosk fleet & sync readiness</h2>
            <p className="mt-1 text-xs text-slate-500 font-mono">
              {systemHealth ? `Checked ${formatRelativeTime(systemHealth.checked_at)}` : 'Health check unavailable'}
            </p>
            {systemHealthStaleCopy && (
              <p className="mt-1 text-xs text-amber-300 font-mono">{systemHealthStaleCopy}</p>
            )}
          </div>
          <Link href={opsKioskHref} className="btn-secondary text-xs">{systemHealthCta}</Link>
        </div>

        {systemHealth ? (
          <>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {systemHealth.kiosks.rows.slice(0, 4).map((kiosk) => (
                <div key={kiosk.id} className="rounded-2xl border border-navy-600/45 bg-navy-900/40 p-4 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-display font-semibold text-sm text-slate-200 truncate">{kiosk.name}</h3>
                      <span className={`badge border text-[10px] ${healthTone(kiosk.status)}`}>{healthLabel(kiosk.status)}</span>
                    </div>
                    <p className="mt-1 text-xs font-mono text-slate-500 truncate">{kiosk.location || kiosk.kiosk_id || 'No location set'}</p>
                    <p className="mt-2 text-[11px] text-slate-500">Last sync {formatRelativeTime(kiosk.last_sync)} · Last upload {formatRelativeTime(kiosk.last_attendance_upload)}</p>
                    {(kiosk.device_issues || []).map((issue) => (
                      <p key={issue} className="mt-1 text-[11px] text-amber-300">{issue}</p>
                    ))}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-2xl font-display font-bold text-slate-200">{kiosk.expected_worker_count}</p>
                    <p className="text-[10px] uppercase tracking-wider text-slate-600">expected</p>
                  </div>
                </div>
              ))}
              {systemHealth.kiosks.rows.length === 0 && (
                <div className="rounded-2xl border border-amber-400/15 bg-amber-400/5 p-4 text-sm text-amber-200">
                  No kiosks are registered yet. Add the first kiosk before employee launch so sync health has something to monitor.
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="rounded-2xl border border-red-400/15 bg-red-400/5 p-4 text-sm text-red-200">
            System health is unavailable right now. Refresh or open Kiosks to inspect device records.
          </div>
        )}
      </section>

      {/* Recent Events */}
      <section className="glass-card p-5 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <p className="section-label">Recent Events</p>
            <h2 className="mt-1 font-display text-lg font-semibold text-slate-100">What just happened</h2>
            <p className="mt-1 text-xs text-slate-500 font-mono">Attendance and system signals from today</p>
          </div>
          <Link href="/log" className="btn-secondary text-xs">Open activity log</Link>
        </div>

        {recentEvents.length === 0 ? (
          <div className="rounded-2xl border border-navy-600/45 bg-navy-900/40 p-4 text-sm text-slate-400">
            No clock events yet today. Kiosk sync and recognition events will appear here as the system starts moving.
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {recentEvents.map((event) => {
              const tone = {
                emerald: 'bg-emerald-400',
                amber: 'bg-amber-400',
                red: 'bg-red-400',
                slate: 'bg-slate-400',
              }[event.tone];
              return (
                <Link key={event.id} href={event.href} data-event-source={event.source} className="rounded-2xl border border-navy-600/45 bg-navy-900/40 p-4 flex items-start gap-3 hover:border-gold/30 transition-colors">
                  <span className={`mt-1.5 h-2.5 w-2.5 rounded-full shrink-0 ${tone}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-xs font-mono uppercase tracking-wider text-slate-500">{event.label}</p>
                      <span className="text-[11px] font-mono text-slate-600 shrink-0">{formatRelativeTime(event.timestamp)}</span>
                    </div>
                    <p className="mt-1 font-display font-semibold text-sm text-slate-200 truncate">{event.title}</p>
                    <p className="mt-1 text-xs text-slate-500 truncate">{event.description}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Attendance roster */}
      <section className="mb-6">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-4">
          <div>
            <p className="section-label">Attendance roster</p>
            <h2 className="mt-1 font-display text-lg font-semibold text-slate-100">Today’s workers</h2>
            <p className="mt-1 text-xs text-slate-500 font-mono">
              {workerCardFreshnessCopy || 'Search active workers by name or department'}
            </p>
          </div>
          <div className="relative w-full md:w-96">
            <svg className="w-4 h-4 text-slate-500 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <input
              type="text"
              placeholder="Search workers by name or department..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input-field pl-11 w-full"
            />
          </div>
        </div>
      </section>

      {/* Worker grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {filtered.map((w) => (
          <WorkerCard
            key={w.id}
            name={w.name}
            department={w.department}
            status={w.status}
            clockInTime={w.clockInTime}
            freshnessLabel={workerCardFreshnessCopy}
            isStale={workerCardsAreStale}
          />
        ))}
      </div>

      {filtered.length === 0 && workers.length > 0 && (
        <div className="text-center py-12 text-slate-500">
          <svg className="w-12 h-12 text-slate-600 mx-auto mb-3" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <p className="font-display text-lg">No workers match your search</p>
          <p className="text-sm mt-1">Try a different name or department</p>
        </div>
      )}

      {workers.length === 0 && !loading && (
        <div className="text-center py-16">
          <svg className="w-16 h-16 text-slate-700 mx-auto mb-4" fill="none" viewBox="0 0 24 24" strokeWidth={0.75} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
          </svg>
          <p className="font-display text-lg text-slate-400">
            {failedSignalKeys.has('workers') ? 'Worker roster unavailable' : 'No workers registered'}
          </p>
          <p className="text-sm text-slate-600 mt-1">
            {failedSignalKeys.has('workers')
              ? 'The roster did not refresh, so this is not a confirmed empty worker list.'
              : 'Add workers from the Workers page to see them here'}
          </p>
        </div>
      )}
    </div>
  );
}
