import jwt from "jsonwebtoken";
import { ApiError } from "../utils/ApiError.js";
import { ACCESS_COOKIE, readCookie } from "../services/token.service.js";

const SECRET = process.env.JWT_SECRET || "dev-secret";

export function requireAuth(req, _res, next) {
  // The browser sends the HttpOnly cookie; API clients and the test suite send a
  // bearer token. Both are accepted so the cookie migration is invisible to
  // existing callers.
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const token = bearer || readCookie(req, ACCESS_COOKIE);

  if (!token) throw new ApiError(401, "Not authenticated");

  try {
    const payload = jwt.verify(token, SECRET);
    req.user = { id: payload.id, email: payload.email };
    next();
  } catch {
    throw new ApiError(401, "Invalid or expired token");
  }
}

export default requireAuth;