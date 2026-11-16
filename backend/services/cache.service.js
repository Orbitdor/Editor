import { cacheConfig } from "../config/cache.js";

/**
 * The read cache (master plan section 49: performance).
 *
 * One module owns every cache concern so the services above it only ever call
 * `getOrSet` / `cacheDel`. Three rules make it safe to put in front of live data:
 *
 *   1. **A cache failure is a miss, never an error.** Every Redis interaction is
 *      wrapped; a broken or slow cache must only cost speed, never correctness
 *      or availability.
 *   2. **Writes invalidate.** Each service drops the keys its mutation touched,
 *      so the person who made the change always sees it on the next read. Only
 *      *other* users' changes can wait out the TTL.
 *   3. **Values are plain JSON.** Nothing is serialised that has not already
 *      been stripped of what must not leave the server (for example the
 *      document's public link token).
 */

/** Resolved once, on first use, so `dotenv` has definitely run by then. */
let config = null;
const cfg = () => (config ??= cacheConfig());

/** The ioredis client, or null when running in memory mode. */
let client = null;
/** True once the socket is ready. A downed Redis is treated as "memory mode". */
let ready = false;
/** Avoids logging the same connection error on every failed command. */
let loggedError = false;

/** Counters for the health endpoint. Cheap, and the only observability we need. */
const stats = { hits: 0, misses: 0, sets: 0, dels: 0, errors: 0 };

/** Tracks an in-flight `getOrSet` per key, so parallel callers share one load. */
const inflight = new Map();

/** In-process fallback store: key -> { v, expiresAt }. */
const memory = new Map();

// ---------------------------------------------------------------------------
// Key building
// ---------------------------------------------------------------------------

/**
 * Build a namespaced cache key from parts.
 *
 * Null/empty parts collapse to `-` so that "no folder" and "no search" produce a
 * stable key instead of one that shifts between calls.
 */
export function cacheKey(...parts) {
  const body = parts
    .map((p) => (p === null || p === undefined || p === "" ? "-" : String(p)))
    .join(":");
  return cfg().keyPrefix + body;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** True when a live Redis is handling reads; false means the memory fallback. */
function usingRedis() {
  return Boolean(client) && ready;
}

/**
 * Open the Redis connection, if one is configured.
 *
 * Called at boot but never awaited by the request path: the API must come up
 * whether or not Redis does. Reconnection is left to ioredis's own retry
 * strategy, so a blip heals without a restart.
 */
export async function connectCache() {
  const c = cfg();
  if (!c.enabled || !c.url || client) return cacheStatus();

  try {
    // Imported lazily so the dependency is only touched when a URL is set. This
    // keeps a Redis-less deployment from paying to load the driver at all.
    const { default: Redis } = await import("ioredis");

    client = new Redis(c.url, {
      // Fail fast on the request path instead of queuing commands behind a dead
      // socket, and cap how long one command may take before it becomes a miss.
      enableOfflineQueue: false,
      commandTimeout: c.commandTimeoutMs,
      connectTimeout: c.connectTimeoutMs,
      // Required when commands may outlive a single request, and harmless here.
      maxRetriesPerRequest: null,
      // Reconnect forever with a capped backoff: the cache is optional, so a
      // long outage should not spam logs or give up permanently.
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });

    client.on("ready", () => {
      ready = true;
      loggedError = false;
      console.log("[cache] redis connected");
    });
    client.on("error", (err) => {
      ready = false;
      if (!loggedError) {
        console.error("[cache] redis error, serving from memory:", err.message);
        loggedError = true;
      }
    });
    client.on("end", () => {
      ready = false;
    });
  } catch (err) {
    // A missing/invalid URL or a missing dependency lands here. Memory mode.
    console.error("[cache] redis unavailable, serving from memory:", err.message);
    client = null;
    ready = false;
  }

  return cacheStatus();
}

/** Close the connection on shutdown. Best effort: a hang here must not block exit. */
export async function shutdownCache() {
  const c = client;
  client = null;
  ready = false;
  if (!c) return;
  try {
    await c.quit();
  } catch {
    try {
      c.disconnect();
    } catch {
      // Already gone.
    }
  }
}

// ---------------------------------------------------------------------------
// In-process fallback
// ---------------------------------------------------------------------------

/** Read the wrapper for a key, honouring its expiry. */
function memoryGet(key) {
  const entry = memory.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    memory.delete(key);
    return undefined;
  }
  return entry;
}

/** Insert a wrapper, evicting the oldest entry when at capacity. */
function memorySet(key, wrapper) {
  const { memoryMax } = cfg();
  if (!memory.has(key) && memory.size >= memoryMax) {
    // Map preserves insertion order, so the first key is the oldest. A rough
    // LRU is fine here: this store only exists to survive between requests in a
    // single process, not as a durable cache.
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, wrapper);
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Read one key.
 *
 * @returns the cached value, or `undefined` on a miss. A cached `null`/`false`/`0`
 *          is a hit and is returned as-is, which is why the sentinel is
 *          `undefined` rather than a falsy check.
 */
export async function cacheGet(key) {
  if (!cfg().enabled) return undefined;
  try {
    if (usingRedis()) {
      const raw = await client.get(key);
      if (raw === null) {
        stats.misses += 1;
        return undefined;
      }
      stats.hits += 1;
      return JSON.parse(raw).v;
    }
    const entry = memoryGet(key);
    if (!entry) {
      stats.misses += 1;
      return undefined;
    }
    stats.hits += 1;
    return entry.v;
  } catch (err) {
    // A failed read is a miss. The caller then hits the database, which is
    // always correct -- just slower.
    stats.errors += 1;
    stats.misses += 1;
    return undefined;
  }
}

/**
 * Store one key. `ttlSeconds` of 0 (or unset) falls back to the configured default.
 */
export async function cacheSet(key, value, ttlSeconds) {
  if (!cfg().enabled || value === undefined) return;
  const ttl = Number(ttlSeconds) > 0 ? Number(ttlSeconds) : cfg().defaultTtl;
  try {
    if (usingRedis()) {
      const payload = JSON.stringify({ v: value });
      if (ttl) await client.set(key, payload, "EX", ttl);
      else await client.set(key, payload);
    } else {
      memorySet(key, { v: value, expiresAt: ttl ? Date.now() + ttl * 1000 : 0 });
    }
    stats.sets += 1;
  } catch {
    stats.errors += 1;
  }
}

/**
 * Delete explicit keys. Always also clears the in-process store, so an entry
 * written during a Redis outage cannot outlive the invalidation that follows it.
 */
export async function cacheDel(...keys) {
  if (!cfg().enabled) return;
  const flat = keys.flat().filter(Boolean).map(String);
  if (!flat.length) return;
  try {
    if (usingRedis()) await client.del(...flat);
  } catch {
    stats.errors += 1;
  }
  for (const key of flat) memory.delete(key);
  stats.dels += flat.length;
}

/**
 * Delete every key beginning with `prefix`.
 *
 * Used where one write invalidates a whole family at once -- for example every
 * dashboard list a single user has cached, which are keyed by scope, folder and
 * search and cannot be enumerated cheaply.
 */
export async function cacheDelPrefix(prefix) {
  if (!cfg().enabled || !prefix) return;
  try {
    if (usingRedis()) {
      // SCAN rather than KEYS: KEYS blocks the Redis server on a large keyspace.
      let cursor = "0";
      do {
        const [next, keys] = await client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
        cursor = next;
        if (keys.length) await client.del(...keys);
      } while (cursor !== "0");
    }
  } catch {
    stats.errors += 1;
  }
  for (const key of [...memory.keys()]) {
    if (key.startsWith(prefix)) memory.delete(key);
  }
  stats.dels += 1;
}

/**
 * The workhorse: return the cached value, or run `loader` once and cache it.
 *
 * Concurrent calls for the same key share a single in-flight load. On a page
 * reload the dashboard fires its reads in parallel, and without this several
 * identical queries would race to fill the same key; with it, one query runs and
 * the rest wait on its promise.
 *
 * A loader failure is deliberately not cached: an error should be retried on the
 * next request, not memoised for the TTL window.
 */
export async function getOrSet(key, ttlSeconds, loader) {
  const hit = await cacheGet(key);
  if (hit !== undefined) return hit;

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const value = await loader();
      if (value !== undefined) await cacheSet(key, value, ttlSeconds);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/** Snapshot for `/api/health`. Never includes the URL, which holds a password. */
export function cacheStatus() {
  const c = cfg();
  return {
    enabled: c.enabled,
    mode: !c.enabled ? "off" : usingRedis() ? "redis" : "memory",
    connected: usingRedis(),
    urlSet: Boolean(c.url),
    ...stats,
  };
}

/**
 * Wipe all state. Test-only: gives each suite a clean cache without needing a
 * Redis FLUSH that could hit someone else's keys.
 */
export function cacheReset() {
  memory.clear();
  inflight.clear();
  stats.hits = 0;
  stats.misses = 0;
  stats.sets = 0;
  stats.dels = 0;
  stats.errors = 0;
}
