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

export const isIn = (list, msg) => (v) =>
  v !== undefined && v !== null && !list.includes(v) && msg;

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