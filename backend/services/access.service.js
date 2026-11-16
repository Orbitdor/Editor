import Document from "../models/doc.model.js";
import Share from "../models/Share.model.js";
import WorkspaceMember, { roleAtLeast } from "../models/WorkspaceMember.model.js";
import { ApiError } from "../utils/ApiError.js";
import { cacheConfig } from "../config/cache.js";
import { cacheDel, cacheDelPrefix, cacheKey, getOrSet } from "./cache.service.js";

/**
 * Role ranking. Higher number = more power. Used by `canAccess`.
 */
const RANK = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4,
};

/**
 * Access lookups used to sit behind a 5-second in-process `Map`. That was fine
 * on one process and useless on serverless, where every instance had its own
 * copy and none of them outlived a restart. They now go through the shared
 * cache, which keeps the same five-second contract but applies it everywhere --
 * and this is the hottest read in the app, because every document open and every
 * WebSocket role re-check resolves a role before it does anything else.
 */
const ACCESS_TTL_SECONDS = cacheConfig().ttl.access;

/**
 * Drop every cached access fact about a document: the share list, and the
 * resolved role for every user who might hold one.
 *
 * The role keys are prefix-deleted because they are namespaced per user, and a
 * share change can alter the role of any number of them at once.
 */
export function invalidateAccessCache(docId) {
  return Promise.all([
    cacheDel(cacheKey("access:shares", docId)),
    cacheDelPrefix(`${cacheKey("access:role", docId)}:`),
  ]);
}

/**
 * True when `role` meets or exceeds `minimum`.
 */
export function canAccess(role, minimum) {
  if (!role) return false;
  return (RANK[role] || 0) >= (RANK[minimum] || 99);
}

/**
 * Read the (cached) share entries for a document.
 *
 * The cached value is the resolved plain array, not a Mongoose cursor, so a hit
 * costs a single JSON parse and no population.
 *
 * @returns {Promise<Array<{_id: string, user: string, email: string, name: string, role: string}>>}
 */
export async function shareEntries(docId) {
  return getOrSet(cacheKey("access:shares", docId), ACCESS_TTL_SECONDS, async () => {
    const rows = await Share.find({ document: docId })
      .select("user email name role")
      .lean();

    return rows.map((r) => ({
      _id: String(r._id),
      user: String(r.user),
      email: r.email,
      name: r.name || "",
      role: r.role,
    }));
  });
}

/**
 * Resolve the caller's effective role on a document.
 *
 * Three sources, strongest first:
 *   1. the document owner,
 *   2. an explicit share on the document,
 *   3. membership of the workspace the document lives in (master plan section 36).
 *
 * An explicit share always wins over workspace membership, because sharing a
 * single document at a higher role than the workspace default is deliberate.
 *
 * The resolved role is cached per (document, user). It is a permission answer
 * rather than content, so the TTL is the short access TTL and every share
 * mutation clears it, which is the same freshness the old in-process cache gave.
 *
 * @param {string} docId
 * @param {string} userId
 * @param {object|null} doc Already-loaded Document (pass it to avoid a re-read).
 * @returns {Promise<"owner"|"editor"|"commenter"|"viewer"|null>}
 */
export async function resolveRole(docId, userId, doc = null) {
  if (!doc || !doc.owner) {
    doc = await Document.findById(docId).select("owner workspace").lean();
    if (!doc) return null;
  }

  // The owner check is a field comparison, so it stays ahead of any cache: it is
  // cheaper than a lookup and can never be stale.
  if (String(doc.owner) === String(userId)) return "owner";

  const workspace = doc.workspace;
  return getOrSet(cacheKey("access:role", docId, userId), ACCESS_TTL_SECONDS, async () => {
    const entries = await shareEntries(docId);
    const shared = entries.find((e) => e.user === String(userId))?.role;
    if (shared) return shared;

    if (!workspace) return null;

    // Workspace membership maps onto the document roles a member already knows.
    const membership = await WorkspaceMember.findOne({
      workspace,
      user: userId,
      status: "active",
    })
      .select("role")
      .lean();
    if (!membership) return null;

    return { admin: "editor", editor: "editor", member: "commenter", viewer: "viewer" }[membership.role] || null;
  });
}

/** Whether the user may act in a workspace at all, at the given role. */
export async function workspaceRoleAtLeast(workspaceId, userId, minimum) {
  if (!workspaceId) return false;
  const membership = await WorkspaceMember.findOne({
    workspace: workspaceId,
    user: userId,
    status: "active",
  })
    .select("role")
    .lean();
  return roleAtLeast(membership?.role, minimum);
}

/**
 * Load a document and assert the caller holds at least `minimum`.
 *
 * `fromCache: true` reads the document body from the cache instead of MongoDB.
 * It is only safe for read-only callers, because the cached copy is a plain
 * object that cannot be `save()`d back -- which is exactly what a read path
 * wants, and exactly what a write path must not get. Every mutation leaves this
 * at the default so it always works against a live document.
 *
 * @returns {Promise<{doc: object, role: string}>}
 */
export async function authorize(docId, userId, minimum = "viewer", { fromCache = false } = {}) {
  const doc = fromCache
    ? await getOrSet(cacheKey("doc:body", docId), cacheConfig().ttl.documents, () =>
        Document.findById(docId)
          // `collabSync` is the CRDT blob the WebSocket layer reads for itself,
          // and `linkShare.token` is the public-link credential the model's
          // transform normally strips: neither belongs in a cache the client
          // could ever be served from.
          .select("-collabSync -linkShare")
          .lean()
      )
    : await Document.findById(docId);
  if (!doc) throw new ApiError(404, "Document not found");

  const role = await resolveRole(docId, userId, doc);
  if (!canAccess(role, minimum)) {
    throw new ApiError(403, "You do not have access to this document");
  }
  return { doc, role };
}

/** Caller may modify document content (title, body, collab CRDT). */
export async function authorizeEdit(docId, userId) {
  const { doc, role } = await authorize(docId, userId, "editor");
  if (doc.trashedAt) throw new ApiError(410, "Document is in trash");
  return { doc, role };
}

/** Caller may create and reply to comments. */
export async function authorizeComment(docId, userId) {
  const { doc, role } = await authorize(docId, userId, "commenter");
  if (doc.trashedAt) throw new ApiError(410, "Document is in trash");
  return { doc, role };
}

/** Owner-only guard: sharing, trashing, starring, tags, hard deletes. */
export async function authorizeOwner(docId, userId) {
  const { doc } = await authorize(docId, userId, "owner");
  return doc;
}

/**
 * Replace the share list of a document and refresh the access cache.
 *
 * The incoming `entries` use the same shape that `shareEntries` returns
 * (`{ user, email, name, role }`), so the whole access layer speaks one shape.
 *
 * @param {import("mongoose").Document} doc
 * @param {Array<{user: string, email: string, name: string, role: string}>} entries
 * @param {string} invitedBy
 */
export async function replaceShares(doc, entries, invitedBy) {
  const rows = entries.filter((e) => e.user);
  const userIds = rows.map((e) => e.user);

  // Remove everyone who is no longer on the list. When the list is empty this
  // clears the document, which is exactly the intent.
  await Share.deleteMany({ document: doc._id, user: { $nin: userIds } });

  // Upsert everyone who is, so role changes and re-invites are idempotent.
  // `user` is repeated inside $set as well: relying on the filter alone leaves
  // the field undefined on insert, and MongoDB then stores a null owner.
  if (rows.length) {
    await Share.bulkWrite(
      rows.map((e) => ({
        updateOne: {
          filter: { document: doc._id, user: e.user },
          update: {
            $set: {
              user: e.user,
              email: e.email,
              name: e.name || "",
              role: e.role,
              invitedBy,
            },
          },
          upsert: true,
        },
      }))
    );
  }

  await invalidateAccessCache(doc._id);
}

/**
 * Plain-JSON shape of a share entry for API responses.
 */
export function serializeShares(entries = []) {
  return entries.map((e) => ({
    userId: e.user,
    email: e.email,
    name: e.name || "",
    role: e.role,
  }));
}

/**
 * User ids that should be notified about activity on a document.
 * Always includes the owner; members are added by the caller when relevant.
 */
export async function participantIds(doc, extraIds = []) {
  const entries = await shareEntries(doc._id);
  const ids = new Set([String(doc.owner), ...extraIds.map(String)]);
  for (const e of entries) ids.add(e.user);
  return [...ids];
}
