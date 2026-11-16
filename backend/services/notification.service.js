import Notification from "../models/Notification.model.js";
import User from "../models/User.model.js";
import { publishToUsers } from "../websocket/notify.server.js";
import { cacheConfig } from "../config/cache.js";
import { cacheDelPrefix, cacheKey, getOrSet } from "./cache.service.js";

/** Hard cap so a misbehaving client can never flood the collection. */
const MAX_PER_BATCH = 50;
/** Feed page size. */
const PAGE_SIZE = 30;

/**
 * Drop a user's cached feed and unread badge.
 *
 * Both are keyed under the user, so one prefix delete clears the list at every
 * page size as well as the badge. Notifications are the one thing a user notices
 * immediately, so this is called on every write rather than left to the TTL.
 */
function invalidateNotificationCaches(userId) {
  if (!userId) return Promise.resolve();
  return cacheDelPrefix(cacheKey("notif", userId));
}

/**
 * Create notifications for many users, silently skipping duplicates/failures.
 *
 * Notifications are a convenience, never a hard dependency: a failure here must
 * not fail the comment that triggered it.
 *
 * @param {string[]} userIds
 * @param {{actor: string, type: string, document?: string, comment?: string, text: string}} payload
 */
export async function notifyMany(userIds, payload) {
  const targets = [...new Set((userIds || []).map(String))].slice(0, MAX_PER_BATCH);
  if (!targets.length) return;

  try {
    await Notification.insertMany(
      targets.map((user) => ({
        user,
        actor: payload.actor,
        type: payload.type,
        document: payload.document,
        comment: payload.comment,
        text: payload.text,
      }))
    );

    // Wake any open tab of the recipient so the badge updates without a poll.
    // Best-effort: a user with no socket is served by their next fetch.
    publishToUsers(targets, {
      type: "notification",
      notificationType: payload.type,
      documentId: payload.document ? String(payload.document) : null,
    });

    // Clear the cached feed so the badge and the list are right on the next
    // load instead of a few seconds later.
    await Promise.all(targets.map(invalidateNotificationCaches));
  } catch (err) {
    // Duplicate key or validation issue: log and continue.
    console.error("[notify] create failed:", err?.message);
  }
}

/**
 * Notification feed for a user, newest first, with actor names resolved.
 */
export async function listNotifications(userId, { limit = PAGE_SIZE } = {}) {
  const capped = Math.min(Number(limit) || PAGE_SIZE, 100);
  return getOrSet(
    cacheKey("notif", userId, "items", capped),
    cacheConfig().ttl.notifications,
    async () => {
      const rows = await Notification.find({ user: userId })
        .sort("-createdAt")
        .limit(capped)
        .populate("actor", "name email")
        .lean();

      return rows.map((r) => ({
        id: String(r._id),
        type: r.type,
        text: r.text,
        documentId: r.document ? String(r.document) : null,
        commentId: r.comment ? String(r.comment) : null,
        read: Boolean(r.read),
        createdAt: r.createdAt,
        actor: r.actor
          ? { id: String(r.actor._id), name: r.actor.name, email: r.actor.email }
          : null,
      }));
    }
  );
}

/** Unread badge count. */
export async function countUnread(userId) {
  return getOrSet(cacheKey("notif", userId, "unread"), cacheConfig().ttl.notifications, () =>
    Notification.countDocuments({ user: userId, read: false })
  );
}

/**
 * Mark notifications as read.
 *
 * @param {string} userId
 * @param {string[]|null} Specific ids, or null for "mark all read".
 */
export async function markRead(userId, ids = null) {
  const filter = { user: userId, read: false };
  if (Array.isArray(ids) && ids.length) filter._id = { $in: ids };
  const result = await Notification.updateMany(filter, { $set: { read: true } });
  await invalidateNotificationCaches(userId);
  return { updated: result.modifiedCount || 0 };
}

/** Remove notifications of a user (used when an account is deleted). */
export async function purgeUserNotifications(userId) {
  await Notification.deleteMany({ user: userId });
  await invalidateNotificationCaches(userId);
}

/**
 * Search users for @mention autocomplete.
 *
 * Excludes the searcher, matches name or email prefix, and returns the minimum
 * fields needed to render a suggestion row.
 */
export async function searchMentionableUsers(currentUserId, query, limit = 8) {
  const q = String(query || "").trim();
  const filter = { _id: { $ne: currentUserId } };
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { email: rx }];
  }

  const users = await User.find(filter).select("name email").limit(Math.min(limit, 20)).lean();
  return users.map((u) => ({ id: String(u._id), name: u.name, email: u.email }));
}
