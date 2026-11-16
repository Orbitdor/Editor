/**
 * Live progress for in-flight OCR extractions.
 *
 * Progress is deliberately not persisted: it is high-churn, short-lived data
 * that only the client that started the extraction ever reads, and it becomes
 * meaningless the moment the request finishes. Keeping it in a plain Map avoids
 * a database write per progress tick.
 *
 * The registry lives in this process, so it assumes a single backend instance.
 * With multiple instances a poll could land on a process that never saw the
 * job; that would require a shared store (Redis) instead.
 */

/** Entries older than this are dropped the next time the registry is touched. */
const TTL_MS = 60_000;

const entries = new Map();

function prune() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, entry] of entries) {
    if (entry.at < cutoff) entries.delete(id);
  }
}

/** Register a new extraction owned by `userId`. A blank id is a no-op. */
export function start(id, userId) {
  if (!id) return;
  prune();
  entries.set(id, {
    userId: String(userId),
    percent: 0,
    status: "starting",
    at: Date.now(),
    done: false,
  });
}

/**
 * Advance an extraction. Percent only ever moves forward and is capped just
 * below 100 so the bar never reads "done" while work is still happening.
 */
export function update(id, percent, status) {
  if (!id) return;
  const entry = entries.get(id);
  if (!entry || entry.done) return;
  const next = Math.max(0, Math.min(99, Math.round(percent)));
  entry.percent = Math.max(entry.percent, next);
  if (status) entry.status = status;
  entry.at = Date.now();
}

/** Mark an extraction complete (100%) or failed. */
export function finish(id, status = "done") {
  if (!id) return;
  const entry = entries.get(id);
  if (!entry) return;
  entry.status = status;
  if (status !== "failed") entry.percent = 100;
  entry.done = true;
  entry.at = Date.now();
}

/** Read progress for `id`, but only for the user who started it. */
export function read(id, userId) {
  const entry = entries.get(id);
  if (!entry || entry.userId !== String(userId)) return null;
  return { percent: entry.percent, status: entry.status, done: entry.done };
}
