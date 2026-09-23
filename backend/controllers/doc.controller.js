import Document from "../models/doc.model.js";

export const getDocs = async (_req, res) => {
  const docs = await Document.find().sort("-updatedAt");
  res.json(docs);
};

export const createDoc = async (_req, res) => {
  const doc = await Document.create({ title: "Untitled", content: "" });
  res.status(201).json(doc);
};

export const getDoc = async (req, res) => {
  const doc = await Document.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "Document not found" });
  res.json(doc);
};

export const saveDoc = async (req, res) => {
  const doc = await Document.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  if (!doc) return res.status(404).json({ error: "Document not found" });
  res.json(doc);
};