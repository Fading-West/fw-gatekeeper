'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
// Type-only import: the directory data itself stays server-side (served via
// /api/employee-directory) so the roster never ships in the client bundle.
import type {
  EmployeeDirectoryEnrollmentEntry,
  EmployeeDirectorySummary,
  EmployeeEnrollmentStatus,
} from '@/lib/employee-directory';
import { usePortalRole } from '@/hooks/usePortalRole';

type Step = 'name' | 'camera' | 'capturing' | 'processing' | 'done' | 'error';

const CAPTURES_REQUIRED = 3;
const CAPTURE_INTERVAL_MS = 1500;

// Per-photo verdicts from the face service's enrollment quality gate (422 detail).
type EnrollmentPhotoResult = { index: number; ok: boolean; reason: string };

const PHOTO_REASON_LABELS: Record<string, string> = {
  no_face: 'no face detected',
  multiple_faces: 'more than one face in frame',
  decode_error: 'image could not be read',
};

function describePhotoIssues(photos: unknown, disagreeingPairs: unknown): string[] {
  const lines: string[] = [];
  if (Array.isArray(photos)) {
    for (const photo of photos as EnrollmentPhotoResult[]) {
      if (!photo || photo.ok || typeof photo.index !== 'number') continue;
      lines.push(`Photo ${photo.index + 1}: ${PHOTO_REASON_LABELS[photo.reason] || photo.reason || 'unusable'}`);
    }
  }
  if (Array.isArray(disagreeingPairs)) {
    for (const pair of disagreeingPairs) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'number' || typeof pair[1] !== 'number') continue;
      lines.push(`Photos ${pair[0] + 1} and ${pair[1] + 1} do not look like the same person`);
    }
  }
  return lines;
}

function EnrollPageContent() {
  const currentRole = usePortalRole();
  const router = useRouter();
  const canEnroll = currentRole === 'admin' || currentRole === 'enrollment';
  const searchParams = useSearchParams();
  const workerId = searchParams.get('worker_id') || '';
  const [step, setStep] = useState<Step>('name');
  const [cameraOpening, setCameraOpening] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const cameraOpeningRef = useRef(false);
  const cameraRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const [name, setName] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [department, setDepartment] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeDirectoryEnrollmentEntry | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [statusFilter, setStatusFilter] = useState<EmployeeEnrollmentStatus | 'all' | 'remaining'>('remaining');
  const [directorySummary, setDirectorySummary] = useState<EmployeeDirectorySummary | null>(null);
  const [completionSummary, setCompletionSummary] = useState<EmployeeDirectorySummary | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState('');
  const [manualEntry, setManualEntry] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [captureCount, setCaptureCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [photoIssues, setPhotoIssues] = useState<string[]>([]);
  const [resultMsg, setResultMsg] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameRef = useRef(name);
  const employeeIdRef = useRef(employeeId);
  const departmentRef = useRef(department);
  const workerIdRef = useRef(workerId);
  const [suggestions, setSuggestions] = useState<EmployeeDirectoryEnrollmentEntry[]>([]);
  nameRef.current = name;
  employeeIdRef.current = employeeId;
  departmentRef.current = department;
  workerIdRef.current = selectedEmployee?.workerId || workerId;

  useEffect(() => {
    if (workerId) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setDirectoryLoading(true);
      setDirectoryError('');
      try {
        const effectiveStatus = name.trim() ? 'all' : statusFilter;
        const res = await fetch(`/api/employee-directory?q=${encodeURIComponent(name.trim())}&status=${effectiveStatus}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Roster unavailable');
        const body = await res.json();
        setSuggestions(Array.isArray(body?.suggestions) ? body.suggestions : []);
        if (body?.summary) setDirectorySummary(body.summary);
      } catch {
        if (!controller.signal.aborted) setDirectoryError('Unable to load the employee roster. Try again in a moment.');
      } finally {
        if (!controller.signal.aborted) setDirectoryLoading(false);
      }
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [name, statusFilter, workerId]);

  const selectEmployee = (employee: EmployeeDirectoryEnrollmentEntry) => {
    setConsentConfirmed(false);
    setName(employee.name);
    setEmployeeId(employee.employeeId);
    setDepartment(employee.department);
    setSelectedEmployee(employee);
    setShowSuggestions(false);
    setManualEntry(false);
    setActiveSuggestion(0);
  };

  const handleNameChange = (value: string) => {
    setConsentConfirmed(false);
    if (selectedEmployee && value !== selectedEmployee.name) {
      if (employeeId === selectedEmployee.employeeId) setEmployeeId('');
      if (department === selectedEmployee.department) setDepartment('');
      setSelectedEmployee(null);
    }
    setName(value);
    if (value.trim()) setStatusFilter('all');
    setShowSuggestions(true);
    setActiveSuggestion(0);
  };

  const handleNameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showSuggestions || suggestions.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveSuggestion((current) => (current + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveSuggestion((current) => (current - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const employee = suggestions[Math.min(activeSuggestion, suggestions.length - 1)];
      if (employee) selectEmployee(employee);
    } else if (event.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  const stopCamera = useCallback(() => {
    cameraRequestRef.current += 1;
    cameraOpeningRef.current = false;
    if (captureTimerRef.current) {
      clearTimeout(captureTimerRef.current);
      captureTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopCamera();
    };
  }, [stopCamera]);

  useEffect(() => {
    setConsentConfirmed(false);
    if (!workerId) return;
    let cancelled = false;
    async function loadWorker() {
      try {
        const res = await fetch(`/api/workers?id=${encodeURIComponent(workerId)}`);
        if (!res.ok) throw new Error('Worker not found');
        const worker = await res.json();
        if (cancelled) return;
        setName(worker.name || '');
        setEmployeeId(worker.employee_id || '');
        setDepartment(worker.department || '');
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : 'Unable to load worker for re-enrollment');
        setStep('error');
      }
    }
    loadWorker();
    return () => { cancelled = true; };
  }, [workerId]);

  const startCamera = async () => {
    if (!canEnroll || cameraOpeningRef.current) return;
    setConsentConfirmed(false);
    cameraOpeningRef.current = true;
    setCameraOpening(true);
    setCameraReady(false);
    const request = ++cameraRequestRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      });
      if (!mountedRef.current || request !== cameraRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      setStep('camera');
    } catch {
      if (!mountedRef.current || request !== cameraRequestRef.current) return;
      setErrorMsg('Camera access denied. Please allow camera permissions and try again.');
      setStep('error');
    } finally {
      if (mountedRef.current && request === cameraRequestRef.current) {
        cameraOpeningRef.current = false;
        setCameraOpening(false);
      }
    }
  };

  useEffect(() => {
    if (step === 'camera' || step === 'capturing') {
      if (videoRef.current && streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
      }
    }
  }, [step]);

  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(video.videoWidth, 640);
    canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  }, []);

  const submitEnrollmentRef = useRef<(photos: string[]) => Promise<void>>(null!);

  const submitEnrollment = async (capturedPhotos: string[]) => {
    try {
      if (!consentConfirmed) throw new Error('Confirm biometric consent for this worker before enrolling.');
      const res = await fetch('/api/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: nameRef.current.trim(),
          employeeId: employeeIdRef.current.trim(),
          department: departmentRef.current.trim(),
          workerId: workerIdRef.current,
          photos: capturedPhotos,
          consent: consentConfirmed,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setPhotoIssues(describePhotoIssues(data.photos, data.disagreeing_pairs));
        throw new Error(data.error || 'Enrollment failed');
      }

      const result = await res.json();
      if (!mountedRef.current) return;
      stopCamera();
      setResultMsg(`Face encoding saved. ${result.photosCount} photos captured.`);
      setStep('done');
      try {
        const progressRes = await fetch('/api/employee-directory?status=not_enrolled');
        const progressBody = progressRes.ok ? await progressRes.json() : null;
        if (mountedRef.current && progressBody?.summary) setCompletionSummary(progressBody.summary);
      } catch {
        // Enrollment succeeded; progress copy can gracefully omit fresh totals.
      }
    } catch (err) {
      if (!mountedRef.current) return;
      stopCamera();
      setErrorMsg(err instanceof Error ? err.message : 'Enrollment failed');
      setStep('error');
    }
  };

  submitEnrollmentRef.current = submitEnrollment;

  const startCapturing = useCallback(() => {
    if (!consentConfirmed) return;
    if (!cameraReady || captureTimerRef.current) return;
    setStep('capturing');
    setCaptureCount(0);
    setPhotos([]);

    const captured: string[] = [];
    let count = 0;
    let attempts = 0;

    const doCapture = () => {
      attempts += 1;
      let frame: string | null = null;
      try { frame = captureFrame(); } catch { /* Retry a transient video frame failure. */ }
      if (frame) {
        captured.push(frame);
        count++;
        setCaptureCount(count);
        setPhotos([...captured]);
      }

      if (count >= CAPTURES_REQUIRED) {
        stopCamera();
        setStep('processing');
        submitEnrollmentRef.current(captured);
        return;
      }

      if (attempts >= 6) {
        stopCamera();
        setErrorMsg('The camera stopped providing images. Reconnect it and try again.');
        setStep('error');
        return;
      }
      captureTimerRef.current = setTimeout(doCapture, CAPTURE_INTERVAL_MS);
    };

    captureTimerRef.current = setTimeout(doCapture, 500);
  }, [cameraReady, captureFrame, consentConfirmed, stopCamera]);

  const enrollNext = () => {
    stopCamera();
    setStep('name');
    setName('');
    setEmployeeId('');
    setDepartment('');
    setSelectedEmployee(null);
    setManualEntry(false);
    setPhotos([]);
    setCaptureCount(0);
    setCameraReady(false);
    setCameraOpening(false);
    setErrorMsg('');
    setResultMsg('');
    setConsentConfirmed(false);
    setPhotoIssues([]);
    setCompletionSummary(null);
    setStatusFilter('remaining');
    setShowSuggestions(true);
    router.replace('/enroll');
  };

  // Viewers cannot submit enrollments (the API rejects them), so stop them
  // here instead of letting them capture photos that will 401 on save.
  if (currentRole !== undefined && currentRole !== 'admin' && currentRole !== 'enrollment') {
    return (
      <div className="min-h-[80vh] flex items-center justify-center p-4 animate-fade-in">
        <div className="glass-card w-full max-w-md px-6 py-8 text-center">
          <h1 className="page-title text-slate-100">
            Face <span className="text-gold">Enrollment</span>
          </h1>
          <p className="mt-3 flex items-center justify-center gap-2">
            <span className="badge border border-slate-400/15 bg-slate-400/5 text-[10px] text-slate-300">Review-only</span>
          </p>
          <p className="mt-3 text-sm text-slate-400">
            Enrolling or updating face data requires an admin or enrollment account. Ask an
            administrator to enroll this worker, or to upgrade your account role.
          </p>
          <Link href="/workers" className="btn-secondary mt-6 inline-flex items-center gap-2">
            Back to Workers
          </Link>
        </div>
      </div>
    );
  }

  // Step: Enter Name
  if (step === 'name') {
    return (
      <div className="min-h-[80vh] flex items-center justify-center p-4 animate-fade-in">
        <div className="w-full max-w-3xl">
          <div className="text-center mb-8">
            <div className="w-14 h-14 rounded-2xl bg-gold/10 border border-gold/20 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-gold" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0zM18.75 10.5h.008v.008h-.008V10.5z" />
              </svg>
            </div>
            <h1 className="page-title text-slate-100">
              Face <span className="text-gold">Enrollment</span>
            </h1>
            <p className="text-slate-400 mt-2 text-sm">{workerId ? 'Update face data for an existing team member' : 'Add a new team member to the gatekeeper system'}</p>
          </div>

          {!workerId && directorySummary && (
            <div className="glass-card mb-4 p-5" aria-label="Enrollment progress">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="section-label">Roster progress</p>
                  <p className="mt-1 text-xl font-display font-semibold text-slate-100">
                    {directorySummary.enrolled} of {directorySummary.total} enrolled
                  </p>
                </div>
                <p className="text-sm font-semibold text-amber-400">{directorySummary.remaining} remaining</p>
              </div>
              <div className="mt-4 h-2 overflow-hidden rounded-full bg-navy-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-gold transition-all"
                  style={{ width: `${directorySummary.total ? (directorySummary.enrolled / directorySummary.total) * 100 : 0}%` }}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
                <span><strong className="text-emerald-400">{directorySummary.enrolled}</strong> recognition ready</span>
                <span><strong className="text-amber-400">{directorySummary.remaining - directorySummary.invalid}</strong> not enrolled</span>
                <span><strong className="text-red-400">{directorySummary.invalid}</strong> needs re-enrollment</span>
              </div>
            </div>
          )}

          <details className="glass-card mb-4 px-5 py-4">
            <summary className="cursor-pointer text-sm font-semibold text-slate-300">
              Enrollment tips &amp; troubleshooting
            </summary>
            <div className="mt-3 space-y-3 text-sm text-slate-400">
              <div>
                <p className="font-semibold text-slate-300">Good photos make good recognition</p>
                <ul className="mt-1 list-disc pl-5 space-y-1">
                  <li>Face the camera straight on, in even lighting — no hats, sunglasses, or masks.</li>
                  <li>Fill the frame with the face; avoid strong backlight from windows.</li>
                  <li>Capture 2–3 photos with slightly different expressions.</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-slate-300">After enrolling</p>
                <ul className="mt-1 list-disc pl-5 space-y-1">
                  <li>Kiosks pull new workers on their next sync cycle (about 30 seconds).</li>
                  <li>Check the Workers page — the worker should show “Face enrolled”.</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-slate-300">If the kiosk doesn’t recognize someone</p>
                <ul className="mt-1 list-disc pl-5 space-y-1">
                  <li>Re-enroll from the Workers page with better lighting.</li>
                  <li>Review low-confidence scans in the Recognition Lab.</li>
                  <li>Confirm the kiosk shows online on the Kiosks page.</li>
                </ul>
              </div>
            </div>
          </details>

          <div className="glass-card p-6 space-y-5">
            {!workerId && !selectedEmployee && !manualEntry && (
              <div>
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="employee-name" className="section-label block">Find an employee</label>
                  {directoryLoading && <span className="text-xs text-slate-500">Updating roster…</span>}
                </div>
                <div className="mt-2 flex flex-wrap gap-2" aria-label="Roster filters">
                  {([
                    ['remaining', `Remaining${directorySummary ? ` (${directorySummary.remaining})` : ''}`],
                    ['enrolled', `Enrolled${directorySummary ? ` (${directorySummary.enrolled})` : ''}`],
                    ['invalid', `Invalid${directorySummary ? ` (${directorySummary.invalid})` : ''}`],
                    ['all', `All${directorySummary ? ` (${directorySummary.total})` : ''}`],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => { setStatusFilter(value); setName(''); setActiveSuggestion(0); setShowSuggestions(true); }}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${statusFilter === value ? 'border-gold/50 bg-gold/15 text-gold' : 'border-navy-600 text-slate-400 hover:text-slate-200'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="relative">
              <label htmlFor="employee-name" className="section-label mb-1.5 block">
                {workerId || selectedEmployee || manualEntry ? 'Full Name *' : 'Search by name, employee ID, or area'}
              </label>
              <input
                id="employee-name"
                type="text"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                onFocus={() => setShowSuggestions(!workerId)}
                onBlur={() => setShowSuggestions(false)}
                onKeyDown={handleNameKeyDown}
                placeholder="Try Alex, F-2, or Station 4"
                autoFocus
                autoComplete="off"
                readOnly={Boolean(selectedEmployee) || Boolean(workerId)}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={showSuggestions && suggestions.length > 0}
                aria-controls="employee-suggestions"
                aria-activedescendant={showSuggestions && suggestions.length > 0 ? `employee-suggestion-${activeSuggestion}` : undefined}
                className="input-field text-lg py-3"
              />
              {!workerId && !selectedEmployee && !manualEntry && showSuggestions && suggestions.length > 0 && (
                <div
                  id="employee-suggestions"
                  role="listbox"
                  className="mt-3 max-h-80 w-full overflow-y-auto rounded-xl border border-navy-600 bg-navy-900"
                >
                  {suggestions.map((employee, index) => (
                    <button
                      key={employee.employeeId}
                      id={`employee-suggestion-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeSuggestion}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectEmployee(employee)}
                      onMouseEnter={() => setActiveSuggestion(index)}
                      className={`flex w-full items-center justify-between gap-4 border-b border-navy-700/60 px-4 py-3 text-left last:border-b-0 ${index === activeSuggestion ? 'bg-gold/10' : 'hover:bg-navy-800'}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-slate-100">{employee.name}</span>
                        <span className="block truncate text-xs text-slate-500">{employee.employeeId} · {employee.department}</span>
                      </span>
                      <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${employee.status === 'enrolled' ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-400' : employee.status === 'invalid' ? 'border-red-400/20 bg-red-400/10 text-red-400' : 'border-amber-400/20 bg-amber-400/10 text-amber-400'}`}>
                        {employee.status === 'enrolled' ? 'Already enrolled' : employee.status === 'invalid' ? 'Needs re-enrollment' : 'Ready to enroll'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {!workerId && !selectedEmployee && !manualEntry && showSuggestions && name.trim() && !directoryLoading && !directoryError && suggestions.length === 0 && (
                <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-sm text-amber-200">
                  No roster match. Check the spelling or employee ID before creating someone new.
                </div>
              )}
              {!workerId && !selectedEmployee && !manualEntry && directoryError && (
                <div role="alert" className="mt-3 rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
                  {directoryError}
                </div>
              )}
              {!workerId && selectedEmployee && (
                <div className={`mt-3 rounded-xl border px-4 py-3 ${selectedEmployee.status === 'enrolled' ? 'border-emerald-400/20 bg-emerald-400/5' : selectedEmployee.status === 'invalid' ? 'border-red-400/20 bg-red-400/5' : 'border-gold/20 bg-gold/5'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-200">
                        {selectedEmployee.status === 'enrolled' ? 'Already enrolled — this will update their face data.' : selectedEmployee.status === 'invalid' ? 'Existing face data is invalid — re-enrollment is recommended.' : 'Roster employee selected and ready to enroll.'}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">{selectedEmployee.employeeId} · {selectedEmployee.department}</p>
                    </div>
                    <button type="button" onClick={() => { setSelectedEmployee(null); setName(''); setEmployeeId(''); setDepartment(''); }} className="btn-ghost shrink-0 text-xs">
                      Change
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="section-label mb-1.5 block">Employee ID Number</label>
              <input
                type="text"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                placeholder="e.g. F-2"
                readOnly={!workerId && !manualEntry}
                className="input-field"
              />
            </div>

            <div>
              <label className="section-label mb-1.5 block">Department</label>
              <input
                type="text"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="e.g. Area Manager, Mill, Station 4"
                readOnly={!workerId && !manualEntry}
                className="input-field"
              />
            </div>

            {!workerId && !selectedEmployee && currentRole === 'admin' && (
              <button
                type="button"
                onClick={() => { setManualEntry((current) => !current); setName(''); setEmployeeId(''); setDepartment(''); }}
                className="btn-ghost w-full text-sm"
              >
                {manualEntry ? 'Back to company roster' : 'Employee not listed? Add manually'}
              </button>
            )}

            <button
              onClick={startCamera}
              disabled={!canEnroll || cameraOpening || !name.trim() || (!workerId && !selectedEmployee && !manualEntry)}
              className="btn-primary w-full py-3.5 text-base flex items-center justify-center gap-2"
            >
              {cameraOpening ? 'Opening camera…' : selectedEmployee?.workerId || workerId ? 'Continue to Re-enrollment' : 'Continue to Camera'}
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
              </svg>
            </button>
          </div>

          <div className="text-center mt-5">
            <Link href="/workers" className="text-sm text-slate-500 hover:text-gold transition-colors font-medium">
              Back to Workers
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Step: Camera Preview
  if (step === 'camera') {
    return (
      <div className="min-h-[80vh] flex items-center justify-center p-4 animate-fade-in">
        <div className="w-full max-w-lg text-center">
          <h2 className="page-title mb-1 text-slate-100">
            Enrolling: <span className="text-gold">{name}</span>
          </h2>
          <p className="text-slate-400 mb-6 text-sm">Position your face in the frame, then tap Start</p>

          <div className="relative rounded-2xl overflow-hidden border-2 border-navy-600/50 mb-5 glass-card">
            <video
              ref={videoRef}
              onLoadedData={() => setCameraReady(Boolean(videoRef.current && videoRef.current.readyState >= 2 && videoRef.current.videoWidth))}
              autoPlay
              playsInline
              muted
              className="w-full aspect-[4/3] bg-navy-950 object-cover"
            />
            {/* Face guide overlay */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-48 h-60 border-2 border-gold/30 rounded-[50%]" />
            </div>
            {/* Corner guides */}
            <div className="absolute top-4 left-4 w-8 h-8 border-t-2 border-l-2 border-gold/40 rounded-tl-lg" />
            <div className="absolute top-4 right-4 w-8 h-8 border-t-2 border-r-2 border-gold/40 rounded-tr-lg" />
            <div className="absolute bottom-4 left-4 w-8 h-8 border-b-2 border-l-2 border-gold/40 rounded-bl-lg" />
            <div className="absolute bottom-4 right-4 w-8 h-8 border-b-2 border-r-2 border-gold/40 rounded-br-lg" />
          </div>

          <label
            htmlFor="biometric-consent"
            className={`glass-card mb-5 flex cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors ${consentConfirmed ? 'border-emerald-400/30' : 'border-amber-400/30'}`}
          >
            <input
              id="biometric-consent"
              type="checkbox"
              checked={consentConfirmed}
              onChange={(event) => setConsentConfirmed(event.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-gold"
              required
            />
            <span className="text-sm text-slate-300">
              The worker has been told that a facial template will be stored for attendance and has agreed.
              <span className="mt-1 block text-xs text-slate-500">
                Required before capture. Face data can be deleted at any time by an admin from the Workers page.
              </span>
            </span>
          </label>

          <div className="space-y-3">
            <button
              onClick={startCapturing}
              disabled={!cameraReady || !consentConfirmed}
              className="btn-primary w-full py-3.5 text-base flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
              </svg>
              {cameraReady ? 'Start Capture' : 'Waiting for camera…'}
            </button>
            <button
              onClick={() => { stopCamera(); setStep('name'); }}
              className="btn-secondary w-full"
            >
              Back
            </button>
          </div>

          <div className="mt-5 glass-card p-3 text-xs text-slate-500 font-mono">
            Tips: Look directly at camera &middot; Good lighting &middot; Remove glasses if possible
          </div>
        </div>
      </div>
    );
  }

  // Step: Auto-capturing
  if (step === 'capturing') {
    return (
      <div className="min-h-[80vh] flex items-center justify-center p-4">
        <div className="w-full max-w-lg text-center">
          <h2 className="page-title mb-1 text-slate-100">
            Capturing: <span className="text-gold">{name}</span>
          </h2>
          <p className="text-gold font-mono text-lg mb-5">
            Hold still... {captureCount}/{CAPTURES_REQUIRED}
          </p>

          <div className="relative rounded-2xl overflow-hidden border-2 border-gold/40 mb-5 shadow-lg shadow-gold/5">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full aspect-[4/3] bg-navy-950 object-cover"
            />
            {/* Flash effect */}
            <div className="absolute inset-0 bg-gold/5 animate-pulse pointer-events-none" />
            {/* Progress bar */}
            <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-navy-800">
              <div
                className="h-full bg-gradient-to-r from-gold to-gold-light transition-all duration-500 ease-out"
                style={{ width: `${(captureCount / CAPTURES_REQUIRED) * 100}%` }}
              />
            </div>
          </div>

          {/* Thumbnails */}
          <div className="flex gap-3 justify-center">
            {Array.from({ length: CAPTURES_REQUIRED }).map((_, i) => (
              <div
                key={i}
                className={`w-16 h-16 rounded-xl border-2 overflow-hidden transition-all ${
                  i < photos.length ? 'border-gold shadow-sm shadow-gold/10' : 'border-navy-600/50'
                }`}
              >
                {photos[i] ? (
                  <img src={photos[i]} alt={`Capture ${i + 1}`} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-navy-800 flex items-center justify-center text-slate-600 text-xs font-mono">
                    {i + 1}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Step: Processing
  if (step === 'processing') {
    return (
      <div className="min-h-[80vh] flex items-center justify-center p-4">
        <div className="text-center animate-fade-in">
          <div className="mx-auto mb-6 h-16 w-16 animate-spin rounded-full border-4 border-gold/20 border-t-gold" />
          <h2 className="page-title text-slate-100">Processing...</h2>
          <p className="text-slate-400 mt-2 font-mono text-sm">Saving photos and generating face encoding</p>
        </div>
      </div>
    );
  }

  // Step: Done
  if (step === 'done') {
    return (
      <div className="min-h-[80vh] flex items-center justify-center p-4 animate-fade-in">
        <div className="w-full max-w-md text-center">
          <div className="w-20 h-20 rounded-full bg-emerald-400/10 border border-emerald-400/20 flex items-center justify-center mx-auto mb-5">
            <svg className="w-10 h-10 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="page-title mb-2 text-slate-100">
            <span className="text-gold">{name}</span> Enrolled!
          </h2>
          <p className="text-slate-400 mb-8 text-sm">{resultMsg}</p>

          {completionSummary && (
            <div className="glass-card mb-6 p-4 text-left">
              <p className="section-label">Roster progress</p>
              <p className="mt-1 text-lg font-display font-semibold text-slate-100">
                {completionSummary.enrolled} of {completionSummary.total} enrolled
              </p>
              <p className="mt-1 text-sm text-amber-400">{completionSummary.remaining} employees remaining</p>
            </div>
          )}

          <div className="space-y-3">
            <button type="button" onClick={enrollNext} className="btn-primary w-full py-3.5 text-base block text-center">
              Enroll Next Employee
            </button>
            <button type="button" onClick={enrollNext} className="btn-secondary block w-full text-center">
              Return to Remaining Roster
            </button>
            <Link href="/workers" className="btn-secondary block w-full text-center">
              View Enrolled Employees
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Step: Error
  return (
    <div className="min-h-[80vh] flex items-center justify-center p-4 animate-fade-in">
      <div className="w-full max-w-md text-center">
        <div className="w-20 h-20 rounded-full bg-red-400/10 border border-red-400/20 flex items-center justify-center mx-auto mb-5">
          <svg className="w-10 h-10 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
        <h2 className="page-title mb-2 text-slate-100">Enrollment Failed</h2>
        <p className={`text-slate-400 text-sm ${photoIssues.length > 0 ? 'mb-4' : 'mb-8'}`}>{errorMsg}</p>
        {photoIssues.length > 0 && (
          <ul className="glass-card mb-8 p-4 text-left text-sm text-slate-300 space-y-1" aria-label="Photo problems">
            {photoIssues.map((issue) => (
              <li key={issue} className="flex gap-2">
                <span className="text-amber-400" aria-hidden="true">-</span>
                <span>{issue}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-3">
          <button
            onClick={() => {
              setPhotos([]);
              setCaptureCount(0);
              setErrorMsg('');
              setPhotoIssues([]);
              setStep('name');
            }}
            className="btn-primary w-full py-3.5 text-base"
          >
            Try Again
          </button>
          <Link href="/workers" className="btn-secondary block w-full text-center">
            Back to Workers
          </Link>
        </div>
      </div>
    </div>
  );
}

function EnrollmentSession() {
  const searchParams = useSearchParams();
  return <EnrollPageContent key={searchParams.get('worker_id') || 'new'} />;
}

export default function EnrollPage() {
  return (
    <Suspense fallback={null}>
      <EnrollmentSession />
    </Suspense>
  );
}
