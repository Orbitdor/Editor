import Comment from "../models/Comment.model.js";
import User from "../models/User.model.js";
import { ApiError } from "../utils/ApiError.js";
import { authorize, authorizeComment, canAccess } from "./access.service.js";
import { notifyMany } from "./notification.service.js";

/** Max characters kept from the quoted anchor text. */
const MAX_QUOTE = 500;
/** Max mentions resolved per comment. */
const MAX_MENTIONS = 20;

/**
 * Serialize a comment row for the API, including author display data.
 */
function serialize(comment) {
  const author = comment.author;
  return {
    id: String(comment._id),
    parentId: comment.parent ? String(comment.parent) : null,
    documentId: String(comment.document),
    body: comment.body,
    quotedText: comment.quotedText || "",
    anchor: {
      from: comment.anchor?.from ?? null,
      to: comment.anchor?.to ?? null,
    },
    mentions: (comment.mentions || []).map((m) => ({
      userId: String(m.user),
      email: m.email,
      name: m.name,
    })),
    resolved: Boolean(comment.resolved),
    resolvedAt: comment.resolvedAt,
    editedAt: comment.editedAt,
    createdAt: comment.createdAt,
    author: author?.userId
      ? {
          id: String(author.userId),
          name: author.name || "",
          email: author.email || "",
        }
      : { id: String(comment.author), name: "Unknown", email: "" },
  };
}

/**
 * Group a flat comment list into thread roots with nested replies.
 * Input may be unsorted; output is oldest-first per thread.
 */
function buildThreads(comments) {
  const byId = new Map();
  for (const c of comments) byId.set(c.id, { ...c, replies: [] });

  const threads = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId).replies.push(node);
    } else {
      threads.push(node);
    }
  }

  const byTime = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);
  threads.sort(byTime);
  for (const t of threads) t.replies.sort(byTime);
  return threads;
}

/**
 * List all comments on a document as resolved threads.
 *
 * Reading is a viewer-level permission: anyone who can read the document can
 * see the discussion, but only commenters and above can take part in it.
 *
 * @param {string} docId
 * @param {string} userId Caller (needs viewer access).
 */
export async function listComments(docId, userId) {
  const { doc } = await authorize(docId, userId, "viewer");
  if (doc.trashedAt) throw new ApiError(410, "Document is in trash");

  const rows = await Comment.find({ document: docId })
    .populate("author", "name email")
    .sort({ createdAt: 1 })
    .lean();

  const comments = rows.map((r) => {
    const author = r.author
      ? { userId: r.author._id, name: r.author.name, email: r.author.email }
      : null;
    return {
      id: String(r._id),
      parentId: r.parent ? String(r.parent) : null,
      documentId: String(r.document),
      body: r.body,
      quotedText: r.quotedText || "",
      anchor: { from: r.anchor?.from ?? null, to: r.anchor?.to ?? null },
      mentions: (r.mentions || []).map((m) => ({
        userId: String(m.user),
        email: m.email,
        name: m.name,
      })),
      resolved: Boolean(r.resolved),
      resolvedAt: r.resolvedAt,
      editedAt: r.editedAt,
      createdAt: r.createdAt,
      author,
    };
  });

  return buildThreads(comments).map(serializeThread);
}

/** Final pass to strip mongoose internals from thread nodes. */
function serializeThread(thread) {
  return { ...serialize(thread), replies: thread.replies.map(serialize) };
}

/** Escape a user supplied string so it can be embedded in a RegExp safely. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve `@name` / `@email` tokens in a comment body to real users.
 *
 * The editor writes mentions as `@[Display Name](userId)` so they survive
 * copy/paste, but plain `@name` is also accepted for hand-typed comments.
 *
 * @returns {Promise<Array<{user: string, email: string, name: string}>>}
 */
async function resolveMentions(body) {
  const tokens = new Set();

  // Structured form emitted by the editor's mention node.
  for (const m of body.matchAll(/@\[[^\]]*\]\(([a-f\d]{24})\)/gi)) {
    tokens.add(m[1]);
  }

  // Plain form: @Name or @email, up to a word boundary.
  const plainTokens = [];
  for (const m of body.replace(/@\[[^\]]*\]\([a-f\d]{24}\)/gi, "").matchAll(/@([\w.@-]{2,64})/g)) {
    plainTokens.push(m[1]);
  }

  if (tokens.size === 0 && plainTokens.length === 0) return [];

  const conditions = [];
  if (tokens.size) conditions.push({ _id: { $in: [...tokens] } });
  if (plainTokens.length) {
    conditions.push({ email: { $in: plainTokens.map((t) => t.toLowerCase()) } });
    // `@Alice` must match the stored name "Alice", so match case-insensitively.
    // The token is escaped because it is user supplied text.
    const patterns = plainTokens.map((t) => new RegExp(`^${escapeRegExp(t)}$`, "i"));
    conditions.push({ name: { $in: patterns } });
  }

  const users = await User.find({ $or: conditions }).select("_id name email").limit(MAX_MENTIONS);
  return users.map((u) => ({ user: u._id, email: u.email, name: u.name }));
}

/**
 * Create a comment thread root.
 *
 * @param {string} docId
 * @param {string} userId Author
 * @param {{body: string, quotedText?: string, from?: number|null, to?: number|null}} payload
 */
export async function createComment(docId, userId, payload) {
  const { doc } = await authorizeComment(docId, userId);

  const body = String(payload.body || "").trim();
  if (!body) throw new ApiError(400, "Comment body is required");

  const mentions = await resolveMentions(body);

  const comment = await Comment.create({
    document: docId,
    parent: null,
    author: userId,
    body,
    quotedText: String(payload.quotedText || "").slice(0, MAX_QUOTE),
    anchor: {
      from: Number.isInteger(payload.from) ? payload.from : null,
      to: Number.isInteger(payload.to) ? payload.to : null,
    },
    mentions,
  });

  // Notify the owner and every mentioned user (never the author themselves).
  const notifyIds = [String(doc.owner), ...mentions.map((m) => String(m.user))].filter(
    (id) => id !== String(userId)
  );
  await notifyMany(notifyIds, {
    actor: userId,
    type: mentions.length ? "mention" : "comment",
    document: docId,
    comment: comment._id,
    text: mentions.length
      ? `${body.slice(0, 140)}`
      : "New comment on your document",
  });

  const author = await User.findById(userId).select("name email").lean();
  return serialize({
    ...comment.toObject(),
    author: { userId, name: author?.name, email: author?.email },
  });
}

/**
 * Reply to an existing thread (or to a reply, keeping depth 1).
 */
export async function replyToComment(docId, commentId, userId, payload) {
  const { doc } = await authorizeComment(docId, userId);

  const parent = await Comment.findOne({ _id: commentId, document: docId });
  if (!parent) throw new ApiError(404, "Comment not found");

  const body = String(payload.body || "").trim();
  if (!body) throw new ApiError(400, "Comment body is required");

  const mentions = await resolveMentions(body);

  // Depth is capped at 1: a reply always points at the thread root.
  const rootId = parent.isRoot() ? parent._id : parent.parent;

  const reply = await Comment.create({
    document: docId,
    parent: rootId,
    author: userId,
    body,
    quotedText: parent.quotedText,
    mentions,
  });

  // Notify the thread author, the document owner and any mentions.
  const notifyIds = new Set(
    [String(parent.author), String(doc.owner), ...mentions.map((m) => String(m.user))].filter(
      (id) => id !== String(userId)
    )
  );
  await notifyMany([...notifyIds], {
    actor: userId,
    type: mentions.length ? "mention" : "comment",
    document: docId,
    comment: reply._id,
    text: body.slice(0, 140),
  });

  const author = await User.findById(userId).select("name email").lean();
  return serialize({
    ...reply.toObject(),
    author: { userId, name: author?.name, email: author?.email },
  });
}

/**
 * Edit your own comment body.
 */
export async function editComment(docId, commentId, userId, payload) {
  await authorizeComment(docId, userId);

  const comment = await Comment.findOne({ _id: commentId, document: docId });
  if (!comment) throw new ApiError(404, "Comment not found");
  if (String(comment.author) !== String(userId)) {
    throw new ApiError(403, "You can only edit your own comments");
  }

  const body = String(payload.body || "").trim();
  if (!body) throw new ApiError(400, "Comment body is required");

  comment.body = body;
  comment.mentions = await resolveMentions(body);
  comment.editedAt = new Date();
  await comment.save();

  // Return the same shape as create/reply so the client can update in place.
  const author = await User.findById(userId).select("name email").lean();
  return serialize({
    ...comment.toObject(),
    author: { userId, name: author?.name, email: author?.email },
  });
}

/**
 * Resolve / unresolve a thread. Viewers cannot, commenters can.
 */
export async function setResolved(docId, commentId, userId, resolved) {
  await authorizeComment(docId, userId);

  const comment = await Comment.findOne({ _id: commentId, document: docId });
  if (!comment) throw new ApiError(404, "Comment not found");
  if (!comment.isRoot()) throw new ApiError(400, "Only thread roots can be resolved");

  comment.resolved = Boolean(resolved);
  comment.resolvedBy = resolved ? userId : null;
  comment.resolvedAt = resolved ? new Date() : null;
  await comment.save({ validateModifiedOnly: true });

  return { id: String(comment._id), resolved: comment.resolved, resolvedAt: comment.resolvedAt };
}

/**
 * Delete a comment. Authors may delete their own; editors and the owner may
 * delete anything. Replies are removed with their root.
 */
export async function deleteComment(docId, commentId, userId) {
  const { role } = await authorizeComment(docId, userId);

  const comment = await Comment.findOne({ _id: commentId, document: docId });
  if (!comment) throw new ApiError(404, "Comment not found");

  const isAuthor = String(comment.author) === String(userId);
  if (!isAuthor && !canAccess(role, "editor")) {
    throw new ApiError(403, "You cannot delete this comment");
  }

  if (comment.isRoot()) {
    await Comment.deleteMany({ $or: [{ _id: comment._id }, { parent: comment._id }] });
  } else {
    await comment.deleteOne();
  }
  return { id: String(commentId), deleted: true };
}

/**
 * Remove every comment of a document. Called when a document is hard-deleted.
 */
export async function purgeDocumentComments(docId) {
  await Comment.deleteMany({ document: docId });
}
