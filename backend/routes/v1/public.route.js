import { Router } from "express";
import { rateLimit } from "../../middleware/error.middleware.js";
import { validateSchema, isId } from "../../middleware/validate.middleware.js";
import * as linkshare from "../../services/linkshare.service.js";
import * as attachments from "../../services/attachment.service.js";

/**
 * Public document access by link (master plan section 21, and the `/shared/:token`
 * row in section 38).
 *
 * This is the only router in the codebase that is deliberately unauthenticated, so
 * it lives in its own file with no `requireAuth` and no path that can be reached by
 * accident. Every handler re-checks the token; nothing here trusts the caller.
 */
const r = Router();

// A link token is a bearer credential, so guessing has to be expensive. Scoped to
// the token paths rather than the whole router, because this router is mounted
// alongside the authenticated "documents shared with me" list on the same prefix
// and that endpoint already has its own limit.
r.use("/:token", rateLimit({ windowMs: 60_000, max: 120, keyFor: (req) => `link:${req.ip}` }));

/** The canonical token check lives in the service; this only adapts it to a rule. */
const isLinkToken = (value) => (linkshare.isLinkToken(value) ? null : "is not a valid link token");

/**
 * GET /api/v1/shared/:token
 *
 * The document, for someone who only has the link. There is no session and no
 * cookie involved, so this cannot be used to read anything else.
 */
r.get("/:token", validateSchema({ token: [isLinkToken] }, "params"), async (req, res) => {
  const { doc, role } = await linkshare.openByLink(req.params.token);
  res.json({
    document: linkshare.serializeLinkDocument(doc, role),
    link: { role, expiresAt: doc.linkShare.expiresAt || null },
  });
});

/**
 * GET /api/v1/shared/:token/attachments/:id
 *
 * The bytes behind an attachment on that document. Scoped to the document the token
 * authorises, so a valid link cannot be used to walk other people's attachment ids.
 *
 * `inline` is gated exactly as it is on the authenticated route, so a link cannot
 * become a way to render an uploaded file as a page on this origin.
 */
r.get(
  "/:token/attachments/:id",
  validateSchema({ token: [isLinkToken], id: [isId()] }, "params"),
  async (req, res) => {
    const { attachment, buffer } = await attachments.readViaLink(req.params.id, req.params.token);
    const inline = req.query.inline === "1" && attachment.kind === "image";
    res
      .status(200)
      .set("Content-Type", inline ? attachment.mime : "application/octet-stream")
      .set("X-Content-Type-Options", "nosniff")
      .set(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(attachment.name)}"`
      )
      .send(buffer);
  }
);

export default r;
