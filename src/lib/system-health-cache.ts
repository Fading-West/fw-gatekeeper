export const SYSTEM_HEALTH_CACHE_TTL_MS = 30_000;
export const SYSTEM_HEALTH_CACHE_MAX_ENTRIES = 64;

// Process-local optimization only. Admin refreshes bypass it so mutation
// freshness does not depend on requests reaching the same portal instance.
// Other instances and writes sent directly to Convex remain subject to the
// 30-second TTL; this cache is not a distributed consistency mechanism.
export class SystemHealthCache {
  private entries = new Map<string, { expiresAt: number; payload: unknown; requestId: number }>();
  private version = 0;
  private readSequence = 0;
  private retiredReadSequence = 0;

  get generation() { return this.version; }

  beginRead() {
    return { generation: this.version, requestId: ++this.readSequence };
  }

  private evict(date: string) {
    const entry = this.entries.get(date);
    if (!entry) return;
    // Retain ordering after TTL/LRU removes a newer result. A single watermark
    // keeps metadata bounded; conservatively skip older fills for other dates
    // too, rather than allowing a delayed response to resurrect stale data.
    this.retiredReadSequence = Math.max(this.retiredReadSequence, entry.requestId);
    this.entries.delete(date);
  }

  private evictExpired() {
    const now = Date.now();
    for (const [date, entry] of this.entries) {
      if (entry.expiresAt <= now) this.evict(date);
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

  set(date: string, payload: unknown, generation: number, requestId = ++this.readSequence) {
    this.evictExpired();
    // A query started before a mutation/refresh must not repopulate stale data.
    if (generation !== this.version) return;
    if (requestId <= this.retiredReadSequence) return;
    // Concurrent misses in the same generation may complete out of order.
    if ((this.entries.get(date)?.requestId ?? -1) > requestId) return;
    this.entries.delete(date);
    this.entries.set(date, { expiresAt: Date.now() + SYSTEM_HEALTH_CACHE_TTL_MS, payload, requestId });
    while (this.entries.size > SYSTEM_HEALTH_CACHE_MAX_ENTRIES) {
      this.evict(this.entries.keys().next().value!);
    }
  }

  invalidate() {
    this.version += 1;
    this.entries.clear();
  }
}

export const systemHealthCache = new SystemHealthCache();
