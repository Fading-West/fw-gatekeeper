/** Identity-only revision: biometric refreshes do not invalidate metadata drafts. */
export function workerIdentityRevision(worker: { name: string; employeeId?: string; department?: string }) {
  return JSON.stringify([
    worker.name.trim().replace(/\s+/g, ' '),
    worker.employeeId?.trim().toLocaleUpperCase() || '',
    worker.department?.trim() || '',
  ]);
}
