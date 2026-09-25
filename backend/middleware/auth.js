import jwt from "jsonwebtoken";
import { ApiError } from "../utils/ApiError.js";

const SECRET = process.env.JWT_SECRET || "dev-secret";

export function requireAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) throw new ApiError(401, "Not authenticated");

  try {
    const payload = jwt.verify(token, SECRET);
    req.user = { id: payload.id, email: payload.email };
    next();
  } catch {
    throw new ApiError(401, "Invalid or expired token");
  }
}