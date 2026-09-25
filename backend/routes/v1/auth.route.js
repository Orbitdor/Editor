import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { validateSchema, required, isString, maxLen } from "../../middleware/validate.middleware.js";
import { rateLimit, securityHeaders } from "../../middleware/error.middleware.js";
import { Login } from "../../controllers/auth/login.controller.js";
import { Register } from "../../controllers/auth/register.controller.js";

const r = Router();

r.use(securityHeaders);

r.post(
  "/register",
  rateLimit({ windowMs: 60_000, max: 10, keyFor: (req) => `reg:${req.ip}` }),
  validateSchema({
    name: [required("is required"), isString(), maxLen(100, "too long")],
    email: [required("is required"), isString(), maxLen(200, "too long")],
    password: [required("is required"), isString(), maxLen(200, "too long")],
  }),
  Register
);

r.post(
  "/login",
  rateLimit({ windowMs: 60_000, max: 20, keyFor: (req) => `login:${req.ip}` }),
  validateSchema({
    email: [required("is required"), isString(), maxLen(200, "too long")],
    password: [required("is required"), isString(), maxLen(200, "too long")],
  }),
  Login
);

export default r;