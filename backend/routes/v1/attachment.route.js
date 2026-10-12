import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { validateSchema, isId, required } from "../../middleware/validate.middleware.js";
import { uploadErrorHandler, uploadSingleFile, uploadSingleImage } from "../../middleware/upload.middleware.js";
import {
  AttachmentCapabilities,
  AttachmentStats,
  DeleteAttachment,
  DownloadAttachment,
  ListAttachments,
  MintSignedUrl,
  ServeSigned,
  UploadAttachment,
  UploadImage,
} from "../../controllers/attachment.controller.js";

/**
 * Attachments (master plan section 27; the `/api/v1/attachments` and
 * `/api/v1/uploads` rows in section 38).
 *
 * One route is deliberately public: `/:id/signed`. Its signature is the
 * credential, as it is for a provider presigned URL, which is what lets an
 * `<img>` tag or a download link work at all. It is safe because the window is
 * short, it is minted only for someone who can already see the document, and it
 * stops working the moment the file is deleted.
 */
const r = Router();

const idParam = { id: [isId()] };
const documentParam = { documentId: [isId()] };

/** What the attach button may send. Cheap, and needs no session to read. */
r.get("/capabilities", AttachmentCapabilities);

// A signed link stands on its own, so it must be reachable without a cookie.
r.get("/:id/signed", validateSchema(idParam, "params"), ServeSigned);

r.use(requireAuth);

r.get("/documents/:documentId", validateSchema(documentParam, "params"), ListAttachments);
r.get("/documents/:documentId/stats", validateSchema(documentParam, "params"), AttachmentStats);

// Any allowed type. The multipart parser and the service both enforce the ceiling.
r.post(
  "/documents/:documentId",
  validateSchema(documentParam, "params"),
  uploadSingleFile,
  uploadErrorHandler,
  UploadAttachment
);

// Images only, and returns an inline URL for the editor to use straight away.
r.post(
  "/documents/:documentId/image",
  validateSchema(documentParam, "params"),
  uploadSingleImage,
  uploadErrorHandler,
  UploadImage
);

r.get("/:id", validateSchema(idParam, "params"), DownloadAttachment);
r.get("/:id/content", validateSchema(idParam, "params"), DownloadAttachment);
r.get("/:id/signed-url", validateSchema(idParam, "params"), MintSignedUrl);
r.delete("/:id", validateSchema(idParam, "params"), DeleteAttachment);

export default r;

/**
 * `/api/v1/uploads` from the section 38 route table, kept as its own router so the
 * document id can arrive in the multipart body rather than in the path. Same
 * handler, same limits, same checks: an alias that behaved differently would be a
 * way around them.
 */
const uploads = Router();
uploads.use(requireAuth);
uploads.post(
  "/",
  // multer has to run first: on a multipart request `req.body` is empty until the
  // parser has consumed the stream, so validating the body beforehand would
  // reject every valid upload as a missing documentId.
  uploadSingleFile,
  uploadErrorHandler,
  // Without `required` a missing documentId is not an error at all, and the
  // request falls through to a lookup that answers 404 -- which reads as "no such
  // document" rather than "you forgot to say which one".
  validateSchema({ documentId: [required("is required"), isId()] }, "body"),
  UploadAttachment
);
export const uploadRouter = uploads;