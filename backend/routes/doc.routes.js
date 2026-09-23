import { Router } from "express";
import {
  getDocs,
  createDoc,
  getDoc,
  saveDoc,
} from "../controllers/doc.controller.js";

const r = Router();

r.get("/", getDocs);
r.post("/", createDoc);
r.get("/:id", getDoc);
r.put("/:id", saveDoc);

export default r;