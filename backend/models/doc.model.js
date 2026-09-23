import mongoose from "mongoose";

const docSchema = new mongoose.Schema(
  {
    title: { type: String, default: "Untitled" },
    content: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("Document", docSchema);