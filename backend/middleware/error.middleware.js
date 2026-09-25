import { ApiError } from "../utils/ApiError.js";

export function notFound(req, _res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) {
    const body = { error: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.statusCode).json(body);
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  console.error("Unhandled error:", err);
  return res.status(500).json({ error: "Internal server error" });
}

export function securityHeaders(_req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-XSS-Protection": "0",
  });
  next();
}

const buckets = new Map();

export function rateLimit({ windowMs = 60_000, max = 120, keyFor } = {}) {
  return (req, res, next) => {
    const key = keyFor(req) || `${req.ip}`;
    const now = Date.now();
    let entry = buckets.get(key);
    if (!entry || now - entry.resetAt > windowMs) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }
    entry.count += 1;
    res.set("X-RateLimit-Limit", String(max));
    res.set("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      return next(new ApiError(429, "Too many requests, slow down"));
    }
    next();
  };
}