import mongoose from "mongoose";
import { plainTextOf } from "../utils/text.js";

const docSchema = new mongoose.Schema(
  {
    title: { type: String, default: "Untitled" },
    content: { type: String, default: "" },
    contentJson: { type: mongoose.Schema.Types.Mixed, default: null },
    plainText: { type: String, default: "" },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /**
     * Which workspace holds this document (master plan section 36).
     *
     * Null on documents created before workspaces existed; those are adopted by
     * the owner's personal workspace the first time it is needed.
     */
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      default: null,
      index: true,
    },
    starred: { type: Boolean, default: false },
    tags: { type: [String], default: [], index: true },
    /**
     * The folder this document is filed under (master plan section 34 lists
     * `folderId` in the document metadata). Null means "My documents", which is
     * why the index is partial rather than plain.
     */
    folder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Folder",
      default: null,
    },
    collabSync: { type: Buffer, default: null },
    /**
     * "Anyone with the link" access (master plan section 21).
     *
     * Kept on the document rather than in the Share collection because it is not
     * per person: it is one capability for the whole document, so it has to be
     * looked up on every anonymous request rather than joined in.
     *
     * The token is 256 bits of `crypto.randomBytes`, so it is not guessable, and
     * the role is capped at commenter by the service -- a writable link on a
     * document is a public edit form, which is not what "share a link" means.
     */
    linkShare: {
      enabled: { type: Boolean, default: false },
      token: { type: String, default: null },
      role: { type: String, enum: ["viewer", "commenter"], default: "viewer" },
      /** When set, the link stops working at this instant. */
      expiresAt: { type: Date, default: null },
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    trashedAt: { type: Date, default: null, index: true },
    lastOpenedAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

// The sidebar filters by workspace plus folder, and "unfiled" is a null lookup
// that a plain index on `folder` would miss.
docSchema.index({ workspace: 1, folder: 1, trashedAt: 1 });

docSchema.index({ owner: 1, title: 1 });
docSchema.index({ owner: 1, trashedAt: 1 });

// The public link lookup hits this on every anonymous request.
//
// The partial filter matters: `linkShare.token` defaults to null, and a plain
// unique index would treat every null as the same key, so the second document
// created would fail to insert. Restricting the index to real strings keeps it
// unique where uniqueness is the point.
docSchema.index(
  { "linkShare.token": 1 },
  { unique: true, partialFilterExpression: { "linkShare.token": { $type: "string" } } }
);

docSchema.pre("save", function () {
  this.plainText = plainTextOf(this);
});

docSchema.methods.owns = function (userId) {
  return String(this.owner) === String(userId);
};

/**
 * `linkShare.token` is the public link credential, so it must never leave the API
 * by accident: a plain `GET /documents/:id` is enough to make any viewer into the
 * holder of a link they were not given. Stripping it here rather than at each call
 * site means a new response shape cannot reintroduce the leak.
 *
 * Both hooks are set because `getDocument` serialises with `toObject()` while
 * anything returned straight from Express goes through `toJSON()`, and a document
 * transformed by one but not the other would still carry the token.
 *
 * The owner reads it through `GET /documents/:id/link`, which is owner-gated.
 */
const stripLinkToken = (_doc, ret) => {
  delete ret.linkShare;
  return ret;
};

docSchema.set("toJSON", { virtuals: false, transform: stripLinkToken });
docSchema.set("toObject", { virtuals: false, transform: stripLinkToken });

export default mongoose.model("Document", docSchema);