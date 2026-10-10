export const SYSTEM_HEALTH_CACHE_TTL_MS = 30_000;
export const SYSTEM_HEALTH_CACHE_MAX_ENTRIES = 64;

// Process-local optimization only. Admin refreshes bypass it so mutation
// freshness does not depend on requests reaching the same portal instance.
export class SystemHealthCache {
  private entries = new Map<string, { expiresAt: number; payload: unknown }>();
  private version = 0;

  get generation() { return this.version; }

  private evictExpired() {
    const now = Date.now();
    for (const [date, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(date);
    }
  }

  get(date: string) {
    this.evictExpired();
    const entry = this.entries.get(date);
    if (!entry) return undefined;
    this.entries.delete(date);
    this.entries.set(date, entry);
    return entry.payload;
  }

  set(date: string, payload: unknown, generation: number) {
    this.evictExpired();
    // A query started before a mutation/refresh must not repopulate stale data.
    if (generation !== this.version) return;
    this.entries.delete(date);
    this.entries.set(date, { expiresAt: Date.now() + SYSTEM_HEALTH_CACHE_TTL_MS, payload });
    while (this.entries.size > SYSTEM_HEALTH_CACHE_MAX_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  invalidate() {
    this.version += 1;
    this.entries.clear();
  }
}

export const systemHealthCache = new SystemHealthCache();
