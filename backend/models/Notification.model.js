import mongoose from "mongoose";

/**
 * In-app notification created by collaboration events.
 *
 * Types:
 *  - mention : user was @mentioned in a comment
 *  - comment : someone replied to the user's comment thread
 *  - share   : a document was shared with the user
 *  - resolve : someone resolved a thread the user participates in
 */
const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    type: {
      type: String,
      enum: ["mention", "comment", "share", "resolve"],
      required: true,
    },
    document: { type: mongoose.Schema.Types.ObjectId, ref: "Document" },
    comment: { type: mongoose.Schema.Types.ObjectId, ref: "Comment" },
    // Pre-rendered sentence so the UI never has to join user/document names.
    text: { type: String, default: "" },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// Notification feed for a user, unread first.
notificationSchema.index({ user: 1, read: 1, createdAt: -1 });

export default mongoose.model("Notification", notificationSchema);
