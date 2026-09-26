'use client';

import { useEffect, useState, useCallback } from 'react';
import { Schedule } from '@/lib/types';
import { useToast } from '@/components/Toast';
import { usePortalRole } from '@/hooks/usePortalRole';

import { isSupportedScheduleTimeRange, SCHEDULE_TIME_ERROR } from '../../../convex/scheduleTimes';
import { parseScheduleDays, SCHEDULE_DAYS_ERROR } from '../../../convex/scheduleValidation';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function SchedulesPage() {
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startTime, setStartTime] = useState('06:00');
  const [endTime, setEndTime] = useState('14:30');
  const [department, setDepartment] = useState('');
  const [departments, setDepartments] = useState<string[]>([]);
  const currentRole = usePortalRole();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const canEdit = currentRole === 'admin';

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/schedules');
      if (!res.ok) {
        throw new Error(res.status === 401 ? 'Your account does not have access to schedules.' : 'Failed to load schedules');
      }
      const body = await res.json().catch(() => []);
      setSchedules(Array.isArray(body) ? body : []);
    } catch (err) {
      setSchedules([]);
      setError(err instanceof Error ? err.message : 'Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDepartments = useCallback(async () => {
    try {
      const res = await fetch('/api/workers');
      if (!res.ok) return;
      const body = await res.json().catch(() => []);
      const workers = Array.isArray(body) ? body : [];
      const depts = [...new Set(workers.map((w: { department: string }) => w.department))] as string[];
      setDepartments(depts.filter(Boolean).sort());
    } catch {
      // Department dropdown stays empty; the form still works without it.
    }
  }, []);

  useEffect(() => { fetchSchedules(); }, [fetchSchedules]);

  useEffect(() => {
    if (canEdit) fetchDepartments();
  }, [canEdit, fetchDepartments]);

  const toggleDay = (d: number) => {
    setDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort());
  };

  const resetForm = () => {
    setName('');
    setDays([1, 2, 3, 4, 5]);
    setStartTime('06:00');
    setEndTime('14:30');
    setDepartment('');
    setEditId(null);
    setShowForm(false);
  };

  const handleEdit = (s: Schedule) => {
    setEditId(s.id);
    setName(s.name);
    setDays(parseScheduleDays(s.days) ?? []);
    setStartTime(s.start_time);
    setEndTime(s.end_time);
    setDepartment(s.department || '');
    setShowForm(true);
  };

  const handleSubmit = async () => {
    if (!name.trim() || days.length === 0) {
      toast('Schedule name and at least one day required', 'error');
      return;
    }

    try {
      if (!isSupportedScheduleTimeRange(startTime, endTime)) throw new Error(SCHEDULE_TIME_ERROR);
      const body = { id: editId, name: name.trim(), days, start_time: startTime, end_time: endTime, department: department || null };

      if (editId) {
        const res = await fetch('/api/schedules', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const responseBody = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(responseBody?.error || 'Failed to update schedule');
        toast(`Schedule "${name}" updated`);
      } else {
        const res = await fetch('/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const responseBody = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(responseBody?.error || 'Failed to create schedule');
        toast(`Schedule "${name}" created`);
      }

      resetForm();
      fetchSchedules();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save schedule', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this schedule?')) return;
    try {
      const res = await fetch(`/api/schedules?id=${id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Failed to delete schedule');
      toast('Schedule deleted');
      fetchSchedules();
    } catch {
      toast('Failed to delete schedule', 'error');
    }
  };

  const parseDays = (daysJson: string): string => {
    const days = parseScheduleDays(daysJson);
    return days ? days.map((d) => DAY_LABELS[d]).join(', ') : 'Invalid days';
  };

  return (
    <div className="animate-fade-in">
      <div className="flex items-start justify-between mb-8 flex-wrap gap-4">
        <div>
          <h1 className="page-title text-slate-100">
            Work <span className="text-gold">Schedules</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1 font-mono">{schedules.length} active schedules</p>
          {!canEdit && (
            <p className="mt-2 flex items-center gap-2">
              <span className="badge border border-slate-400/15 bg-slate-400/5 text-[10px] text-slate-300">Review-only</span>
              <span className="text-xs text-slate-500">Managing schedules requires an admin account.</span>
            </p>
          )}
        </div>
        {canEdit && (
          <button
            onClick={() => { resetForm(); setShowForm(!showForm); }}
            className={showForm ? 'btn-secondary' : 'btn-primary flex items-center gap-2'}
          >
            {showForm ? 'Cancel' : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                New Schedule
              </>
            )}
          </button>
        )}
      </div>

      {canEdit && showForm && (
        <div className="glass-card p-6 mb-8 space-y-5 animate-slide-up">
          <h2 className="font-display font-semibold text-gold flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
            </svg>
            {editId ? 'Edit Schedule' : 'New Schedule'}
          </h2>

          <div>
            <label className="section-label mb-1.5 block">Schedule Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Default Mon-Fri"
              className="input-field"
            />
          </div>

          <div>
            <label className="section-label mb-2 block">Days of Week</label>
            <div className="flex gap-2">
              {DAY_LABELS.map((label, i) => (
                <button
                  key={i}
                  onClick={() => toggleDay(i)}
                  className={`w-11 h-11 rounded-xl text-xs font-display font-medium transition-all ${
                    days.includes(i)
                      ? 'bg-gold/15 text-gold border border-gold/25 shadow-sm shadow-gold/5'
                      : 'bg-navy-900/80 text-slate-500 border border-navy-600/50 hover:border-slate-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="section-label mb-1.5 block">Start Time</label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="input-field font-mono"
              />
            </div>
            <div>
              <label className="section-label mb-1.5 block">End Time</label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="input-field font-mono"
              />
            </div>
          </div>

          <div>
            <label className="section-label mb-1.5 block">Department (optional)</label>
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="input-field"
            >
              <option value="">All Departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>

          <button
            onClick={handleSubmit}
            disabled={!name.trim() || days.length === 0}
            className="btn-primary"
          >
            {editId ? 'Update Schedule' : 'Create Schedule'}
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-6 rounded-xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="glass-card p-6 text-sm text-slate-400">Loading schedules...</div>
      ) : error ? null : schedules.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <svg className="w-12 h-12 text-slate-600 mx-auto mb-3" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
          </svg>
          <p className="text-slate-400 font-display">No schedules yet</p>
          <p className="text-xs text-slate-600 mt-1">Create one to enable daily attendance tracking</p>
        </div>
      ) : (
        <div className="space-y-3">
          {schedules.map((s, i) => (
            <div key={s.id} className={`glass-card-hover p-5 flex items-center justify-between animate-fade-in stagger-${Math.min(i + 1, 6)}`}>
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-gold/10 border border-gold/15 flex items-center justify-center text-gold">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <div className="font-display font-medium text-slate-200">{s.name}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs font-mono text-slate-400">{parseDays(s.days)}</span>
                    {!parseScheduleDays(s.days) && <p role="alert" className="text-sm text-red-400 mt-2">Unsupported schedule: {SCHEDULE_DAYS_ERROR}</p>}
                    <span className="text-slate-600">&middot;</span>
                    <span className="text-xs font-mono text-gold tabular-nums">{s.start_time} &ndash; {s.end_time}</span>
                    {!isSupportedScheduleTimeRange(s.start_time, s.end_time) && <p role="alert" className="text-sm text-red-400 mt-2">Unsupported schedule: {SCHEDULE_TIME_ERROR}</p>}
                    {s.department && (
                      <>
                        <span className="text-slate-600">&middot;</span>
                        <span className="badge text-[10px] bg-gold/10 text-gold/70 border border-gold/15">{s.department}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                {canEdit ? (
                  <>
                    <button onClick={() => handleEdit(s)} className="btn-ghost text-xs">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                      </svg>
                    </button>
                    <button onClick={() => handleDelete(s.id)} className="px-3 py-1.5 text-xs rounded-xl bg-red-400/5 border border-red-400/10 text-red-400 hover:bg-red-400/10 transition-all">
                      Delete
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-secondary text-xs" disabled>
                    Review-only
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
