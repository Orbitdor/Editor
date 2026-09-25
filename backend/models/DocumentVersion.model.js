import mongoose from "mongoose";

const versionSchema = new mongoose.Schema(
  {
    document: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
      required: true,
      index: true,
    },
    version: { type: Number, required: true },
    title: { type: String, default: "" },
    content: { type: String, default: "" },
    contentJson: { type: mongoose.Schema.Types.Mixed, default: null },
    plainText: { type: String, default: "" },
    savedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

versionSchema.index({ document: 1, version: -1 });

export default mongoose.model("DocumentVersion", versionSchema);