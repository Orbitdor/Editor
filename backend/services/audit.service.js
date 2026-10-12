import mongoose from "mongoose";
import ActivityLog, { ACTIVITY_ACTIONS } from "../models/ActivityLog.model.js";
import { ApiError } from "../utils/ApiError.js";

/**
 * Audit trail (master plan section 49).
 *
 * `record` is deliberately fire-and-forget for the caller: an audit write must
 * never fail the business action it is describing, because losing a document
 * save because the log was unavailable would be far worse than a missing line.
 * Failures are logged to the server console instead.
 */

const MAX_META_STRING = 200;

/** Trim caller-supplied detail so a log line cannot smuggle in a huge payload. */
function cleanMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value == null) continue;
    out[key] = typeof value === "string" ? value.slice(0, MAX_META_STRING) : value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Append one entry to a workspace's audit log.
 *
 * @param {string} workspaceId
 * @param {{action: string, actor?: object, resource?: object, req?: object, meta?: object}} entry
 * @returns {Promise<object|null>} The stored entry, or null if the write failed.
 */
export async function record(workspaceId, { action, actor, resource, req, meta } = {}) {
  if (!workspaceId || !action) return null;

  try {
    const row = await ActivityLog.create({
      workspace: workspaceId,
      actor: actor?.id || actor?._id || null,
      actorName: actor?.name || null,
      action,
      resource: resource
        ? {
            type: resource.type || null,
            id: resource.id ? String(resource.id) : null,
            name: resource.name ? String(resource.name).slice(0, MAX_META_STRING) : null,
          }
        : null,
      ip: req?.ip || null,
      userAgent: req?.get?.("user-agent")?.slice(0, 300) || null,
      meta: cleanMeta(meta),
    });
    return row;
  } catch (err) {
    console.error(`audit: could not record ${action}:`, err.message);
    return null;
  }
}

/**
 * Read a workspace's audit log, newest first.
 *
 * @param {string} workspaceId
 * @param {{limit?: number, before?: string, actor?: string, action?: string}} [filter]
 */
export async function list(workspaceId, { limit = 50, before = null, actor = null, action = null } = {}) {
  const capped = Math.min(Number(limit) || 50, 200);
  const query = { workspace: workspaceId };
  if (actor) query.actor = actor;
  if (action) query.action = action;
  // Keyset pagination on the timestamp: cheaper than skipping through a large
  // result set and stable when new rows arrive while the user scrolls.
  if (before) query.createdAt = { $lt: before };

  const rows = await ActivityLog.find(query).sort({ createdAt: -1 }).limit(capped + 1).lean();
  const hasMore = rows.length > capped;
  const page = hasMore ? rows.slice(0, capped) : rows;

  return {
    entries: page.map((row) => ({
      id: String(row._id),
      action: row.action,
      actor: row.actor ? String(row.actor) : null,
      actorName: row.actorName,
      resource: row.resource,
      meta: row.meta,
      ip: row.ip,
      createdAt: row.createdAt,
    })),
    nextCursor: hasMore ? page[page.length - 1].createdAt : null,
  };
}

/** Aggregate counts per action, for the admin dashboard. */
export async function summary(workspaceId, { since = null } = {}) {
  // Aggregation pipelines are not cast by Mongoose the way `find` is, so a plain
  // string id would silently match nothing. Cast it here instead.
  const match = {
    workspace: mongoose.isValidObjectId(workspaceId)
      ? new mongoose.Types.ObjectId(workspaceId)
      : workspaceId,
  };
  if (since) match.createdAt = { $gte: since };

  const rows = await ActivityLog.aggregate([
    { $match: match },
    { $group: { _id: "$action", count: { $sum: 1 }, lastAt: { $max: "$createdAt" } } },
    { $sort: { count: -1 } },
  ]);

  return rows.map((r) => ({
    action: r._id,
    count: r.count,
    lastAt: r.lastAt,
  }));
}

export { ACTIVITY_ACTIONS };

/** Reject an unknown filter action early, rather than returning a silently empty page. */
export function assertKnownAction(action) {
  if (action && !ACTIVITY_ACTIONS.includes(action)) {
    throw new ApiError(400, `Unknown activity action: ${action}`);
  }
}