import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SystemHealthCache, SYSTEM_HEALTH_CACHE_MAX_ENTRIES, SYSTEM_HEALTH_CACHE_TTL_MS } from './system-health-cache';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());

it('caps distinct dates and evicts the least recently used entry', () => {
  const cache = new SystemHealthCache();
  for (let i = 0; i < SYSTEM_HEALTH_CACHE_MAX_ENTRIES; i++) cache.set(String(i), i, cache.generation);
  expect(cache.get('0')).toBe(0);
  cache.set('new', 'new', cache.generation);
  expect(cache.get('1')).toBeUndefined();
  expect(cache.get('0')).toBe(0);
  for (let i = 100; i < 1100; i++) cache.set(String(i), i, cache.generation);
  expect(Array.from({ length: 1100 }, (_, i) => cache.get(String(i))).filter(value => value !== undefined))
    .toHaveLength(SYSTEM_HEALTH_CACHE_MAX_ENTRIES);
});

it('expires entries even when reads keep them recently used', () => {
  const cache = new SystemHealthCache();
  cache.set('old', 'old', cache.generation);
  vi.advanceTimersByTime(SYSTEM_HEALTH_CACHE_TTL_MS - 1);
  expect(cache.get('old')).toBe('old');
  cache.set('new', 'new', cache.generation);
  vi.advanceTimersByTime(1);
  expect(cache.get('old')).toBeUndefined();
  expect(cache.get('new')).toBe('new');
});

it('does not let an in-flight query restore data invalidated by a mutation', () => {
  const cache = new SystemHealthCache();
  const oldGeneration = cache.generation;
  cache.set('today', 'before', oldGeneration);
  cache.invalidate();
  cache.set('today', 'fresh', cache.generation);
  cache.set('today', 'stale', oldGeneration);
  expect(cache.get('today')).toBe('fresh');
});

it('rejects a pre-invalidation read even before a replacement is cached', () => {
  const cache = new SystemHealthCache();
  const older = cache.beginRead();
  cache.invalidate();
  cache.set('today', 'stale', older.generation, older.requestId);
  expect(cache.get('today')).toBeUndefined();
});

it('does not restore an older response after the newer entry expires', () => {
  const cache = new SystemHealthCache();
  const older = cache.beginRead();
  const newer = cache.beginRead();
  cache.set('today', 'newer', newer.generation, newer.requestId);
  vi.advanceTimersByTime(SYSTEM_HEALTH_CACHE_TTL_MS);
  cache.set('today', 'older', older.generation, older.requestId);
  expect(cache.get('today')).toBeUndefined();
  const latest = cache.beginRead();
  cache.set('today', 'latest', latest.generation, latest.requestId);
  expect(cache.get('today')).toBe('latest');
});

it('does not restore an older response after the newer entry is evicted by LRU', () => {
  const cache = new SystemHealthCache();
  const older = cache.beginRead();
  const newer = cache.beginRead();
  cache.set('today', 'newer', newer.generation, newer.requestId);
  for (let i = 0; i < SYSTEM_HEALTH_CACHE_MAX_ENTRIES; i++) cache.set(String(i), i, cache.generation);
  expect(cache.get('today')).toBeUndefined();
  cache.set('today', 'older', older.generation, older.requestId);
  expect(cache.get('today')).toBeUndefined();
  const latest = cache.beginRead();
  cache.set('today', 'latest', latest.generation, latest.requestId);
  expect(cache.get('today')).toBe('latest');
});
