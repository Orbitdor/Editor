import * as commentService from "../services/comment.service.js";
import * as shareService from "../services/share.service.js";
import * as linkShareService from "../services/linkshare.service.js";
import * as notificationService from "../services/notification.service.js";

/**
 * Comments
 */

// GET /api/v1/documents/:id/comments
export const listComments = async (req, res) => {
  res.json(await commentService.listComments(req.params.id, req.user.id));
};

// POST /api/v1/documents/:id/comments
export const createComment = async (req, res) => {
  const comment = await commentService.createComment(req.params.id, req.user.id, req.body);
  res.status(201).json(comment);
};

// POST /api/v1/documents/:id/comments/:commentId/replies
export const replyComment = async (req, res) => {
  const comment = await commentService.replyToComment(
    req.params.id,
    req.params.commentId,
    req.user.id,
    req.body
  );
  res.status(201).json(comment);
};

// PATCH /api/v1/documents/:id/comments/:commentId
export const editComment = async (req, res) => {
  res.json(await commentService.editComment(req.params.id, req.params.commentId, req.user.id, req.body));
};

// POST /api/v1/documents/:id/comments/:commentId/resolve
export const resolveComment = async (req, res) => {
  res.json(
    await commentService.setResolved(
      req.params.id,
      req.params.commentId,
      req.user.id,
      req.body.resolved
    )
  );
};

// DELETE /api/v1/documents/:id/comments/:commentId
export const deleteComment = async (req, res) => {
  res.json(await commentService.deleteComment(req.params.id, req.params.commentId, req.user.id));
};

/**
 * Sharing and permissions
 */

// GET /api/v1/documents/:id/share
export const getShare = async (req, res) => {
  res.json(await shareService.getShareState(req.params.id, req.user.id));
};

// PUT /api/v1/documents/:id/share
export const putShare = async (req, res) => {
  res.json(await shareService.upsertShare(req.params.id, req.user.id, req.body));
};

// DELETE /api/v1/documents/:id/share/:userId
export const removeShare = async (req, res) => {
  res.json(await shareService.removeShare(req.params.id, req.user.id, req.params.userId));
};

// GET /api/v1/shared -> documents other people shared with me
// Mounted directly on the router (no per-request binding), so it takes the
// user id rather than (req, res) like the other handlers.
export const listSharedWithMe = async (userId) => shareService.listSharedWithMe(userId);

// GET /api/v1/documents/:id/access
export const getAccess = async (req, res) => {
  res.json(await shareService.myAccess(req.params.id, req.user.id));
};

/**
 * "Anyone with the link"
 */

// GET /api/v1/documents/:id/link
export const getLinkShare = async (req, res) => {
  res.json(await linkShareService.getLinkShare(req.params.id, req.user.id));
};

// PUT /api/v1/documents/:id/link
export const putLinkShare = async (req, res) => {
  res.json(await linkShareService.setLinkShare(req.params.id, req.user.id, req.body));
};

// DELETE /api/v1/documents/:id/link
export const deleteLinkShare = async (req, res) => {
  res.json(await linkShareService.revokeLinkShare(req.params.id, req.user.id));
};

/**
 * Notifications
 */

// GET /api/v1/notifications
export const listNotifications = async (req, res) => {
  const [items, unread] = await Promise.all([
    notificationService.listNotifications(req.user.id, { limit: req.query.limit }),
    notificationService.countUnread(req.user.id),
  ]);
  res.json({ items, unread });
};

// POST /api/v1/notifications/read
export const markNotificationsRead = async (req, res) => {
  res.json(await notificationService.markRead(req.user.id, req.body?.ids ?? null));
};

/**
 * Mention autocomplete
 */

// GET /api/v1/users/search
export const searchUsers = async (req, res) => {
  res.json(
    await notificationService.searchMentionableUsers(req.user.id, req.query.q, req.query.limit)
  );
};
