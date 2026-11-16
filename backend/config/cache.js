/**
 * Read-cache configuration (Redis with an in-process fallback).
 *
 * The editor's slow paths are all reads that repeat on every page load: the
 * dashboard's document list, the workspace list, the folder tree, the
 * notification feed, and the share/role lookups behind every document open. They
 * are ideal cache candidates because the data changes rarely and every write
 * path already goes through a service that can invalidate the entry.
 *
 * Redis is optional on purpose. A single-process deployment (local dev, the test
 * suite, one VPS) gets the same behaviour from a small in-process Map, so a
 * missing `REDIS_URL` is not an error -- it just means the cache is not shared
 * between processes and does not survive a restart. Paste a URL in `backend/.env`
 * to turn the shared cache on with no code change.
 *
 * Nothing here ever holds a secret: the Redis password lives in `REDIS_URL`,
 * which is git-ignored like the rest of `backend/.env`.
 */

/** Read a value from several possible env var names. */
const pick = (...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
};

/** Parse an env var as a positive integer, falling back to a default. */
const num = (name, fallback) => {
  const raw = pick(name);
  // An unset var reaches here as `""`, and `Number("")` is 0 -- which would
  // silently disable the memory cache and every TTL. Absent means default.
  if (raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

/**
 * Cache TTLs, in seconds, per family of data.
 *
 * These are deliberately short. The contract is "a few seconds of staleness is
 * fine, and your own writes are always visible immediately", so the TTL only
 * has to cover *other people's* changes: a teammate's edit, a new comment, a
 * share being revoked. Anything the current user does invalidates the key
 * straight away rather than waiting out the TTL.
 */
export function cacheConfig() {
  const url = pick("REDIS_URL", "REDIS_URI");
  return {
    /** `CACHE_ENABLED=false` turns the whole layer off, even in memory mode. */
    enabled: pick("CACHE_ENABLED").toLowerCase() !== "false",
    url,
    /** Namespace every key so a second app on the same Redis cannot collide. */
    keyPrefix: pick("CACHE_KEY_PREFIX") || "doced:",
    /** TTL used when a caller does not supply one. */
    defaultTtl: num("CACHE_DEFAULT_TTL", 30),
    /** Cap for the in-process fallback, so it can never grow without bound. */
    memoryMax: num("CACHE_MEMORY_MAX", 500),
    connectTimeoutMs: num("CACHE_CONNECT_TIMEOUT_MS", 3000),
    /**
     * A Redis command may add at most this much latency before the cache gives
     * up and treats the read as a miss. Without it a half-open connection would
     * turn every request into a slow request, which is the opposite of the point.
     */
    commandTimeoutMs: num("CACHE_COMMAND_TIMEOUT_MS", 500),
    ttl: {
      documents: num("CACHE_TTL_DOCUMENTS", 30),
      workspaces: num("CACHE_TTL_WORKSPACES", 30),
      folders: num("CACHE_TTL_FOLDERS", 30),
      notifications: num("CACHE_TTL_NOTIFICATIONS", 15),
      comments: num("CACHE_TTL_COMMENTS", 15),
      templates: num("CACHE_TTL_TEMPLATES", 300),
      /**
       * Access is the shortest of all, because it is a permission question.
       * Five seconds matches the in-process access cache the codebase used
       * before this existed, so a share revoke takes effect exactly as fast as
       * it always did -- just on every process instead of one.
       */
      access: num("CACHE_TTL_ACCESS", 5),
    },
  };
}
