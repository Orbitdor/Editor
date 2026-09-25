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
    starred: { type: Boolean, default: false },
    tags: { type: [String], default: [], index: true },
    trashedAt: { type: Date, default: null, index: true },
    lastOpenedAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

docSchema.index({ owner: 1, title: 1 });
docSchema.index({ owner: 1, trashedAt: 1 });

docSchema.pre("save", function () {
  this.plainText = plainTextOf(this);
});

docSchema.methods.owns = function (userId) {
  return String(this.owner) === String(userId);
};

export default mongoose.model("Document", docSchema);