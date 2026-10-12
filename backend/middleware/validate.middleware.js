import { ApiError } from "../utils/ApiError.js";

export const required = (msg) => (v) => (v === undefined || v === null || v === "") && msg;

export const isString = (msg = "must be a string") => (v) =>
  v !== undefined && v !== null && typeof v !== "string" && msg;

export const isBoolean = (msg = "must be a boolean") => (v) =>
  v !== undefined && v !== null && typeof v !== "boolean" && msg;

export const isArrayOfStrings = (msg = "must be an array of strings") => (v) => {
  if (v === undefined || v === null) return false;
  if (!Array.isArray(v)) return msg;
  return v.some((x) => typeof x !== "string") ? msg : false;
};

export const maxLen = (n, msg) => (v) =>
  v !== undefined && v !== null && String(v).length > n && msg;

export const isId = (msg = "invalid id") => (v) =>
  v !== undefined && v !== null && !/^[a-f\d]{24}$/i.test(String(v)) && msg;

/**
 * A pragmatic email check: one `@`, no spaces, and a dotted domain. Deliberately
 * not RFC 5322, which rejects addresses that deliver perfectly well.
 */
export const isEmail = (msg = "must be a valid email address") => (v) => {
  if (v === undefined || v === null) return false;
  const value = String(v).trim();
  if (value.length > 254 || /\s/.test(value)) return msg;
  return /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(value) ? false : msg;
};

/** Integer >= 1, used for version numbers in the URL. */
export const isPositiveInt = (msg = "must be a positive integer") => (v) =>
  v !== undefined && v !== null && (!Number.isInteger(Number(v)) || Number(v) < 1) && msg;

export const isIn = (list, msg) => (v) =>
  v !== undefined && v !== null && !list.includes(v) && msg;

/**
 * Optional non-negative integer. Used for ProseMirror positions, which may be
 * `null` when a comment is not anchored to a text range.
 */
export const isIntOrNull = (msg = "must be an integer or null") => (v) => {
  if (v === undefined || v === null || v === "") return false;
  return !Number.isInteger(Number(v)) && msg;
};

/** Optional finite number. Used for measured values such as clip duration. */
export const isNumber = (msg = "must be a number") => (v) =>
  v !== undefined && v !== null && v !== "" && !Number.isFinite(Number(v)) && msg;

/** Optional number that cannot be negative, e.g. seconds of speech. */
export const isNonNegativeNumber = (msg = "must be a number of 0 or more") => (v) => {
  // An absent value is allowed; only a present, unparsable or negative one fails.
  if (v === undefined || v === null || v === "") return false;
  if (!Number.isFinite(Number(v))) return msg;
  return Number(v) < 0 && msg;
};

export function validateSchema(schema, source = "body") {
  return (req, _res, next) => {
    const data = req[source] ?? {};
    const errors = [];
    for (const [key, rules] of Object.entries(schema)) {
      const value = data[key];
      for (const rule of rules) {
        const err = rule(value, data);
        if (err) {
          errors.push(`${key} ${err}`);
          break;
        }
      }
    }
    if (errors.length) {
      return next(new ApiError(400, "Validation failed", errors));
    }
    next();
  };
}