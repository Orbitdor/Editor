import { getToken } from "@/lib/auth";

const API_ROOT = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000"
).replace(/\/+$/, "");

const BASE = `${API_ROOT}/api/v1/documents`;
const AUTH = `${API_ROOT}/api/v1/auth`;

function authHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function request(url, options = {}) {
  const headers = { ...authHeaders(), ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const body = await res.json();
      message = body.error || body.message || message;
    } catch {
      // keep default message
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function registerUser(name, email, password) {
  const res = await fetch(`${AUTH}/register`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Register failed");
  return data;
}

export async function loginUser(email, password) {
  const res = await fetch(`${AUTH}/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Login failed");
  return data;
}

export function getDocs(params = {}) {
  const qs = new URLSearchParams();
  if (params.scope) qs.set("scope", params.scope);
  if (params.q) qs.set("q", params.q);
  if (params.tags) qs.set("tags", params.tags);
  const q = qs.toString();
  return request(q ? `${BASE}?${q}` : BASE);
}

export function createDoc(body = {}) {
  return request(BASE, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function getDoc(id) {
  return request(`${BASE}/${id}`);
}

export function saveDoc(id, body) {
  return request(`${BASE}/${id}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

export function trashDoc(id) {
  return request(`${BASE}/${id}/trash`, { method: "POST" });
}

export function restoreDoc(id) {
  return request(`${BASE}/${id}/restore`, { method: "POST" });
}

export function starDoc(id, starred) {
  return request(`${BASE}/${id}/star`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ starred }),
  });
}

export function tagDoc(id, tags) {
  return request(`${BASE}/${id}/tags`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ tags }),
  });
}

export function getDocVersions(id) {
  return request(`${BASE}/${id}/versions`);
}

export function restoreVersion(id, version) {
  return request(`${BASE}/${id}/versions/${version}/restore`, { method: "POST" });
}

export function exportUrl(id, format = "markdown") {
  return `${BASE}/${id}/export?format=${format}`;
}

export async function exportDocBlob(id, format = "markdown") {
  const res = await fetch(exportUrl(id, format), { headers: authHeaders() });
  if (!res.ok) {
    let message = `Export failed: ${res.status}`;
    try {
      const body = await res.json();
      message = body.error || message;
    } catch {
      // keep default message
    }
    throw new Error(message);
  }
  return res.blob();
}