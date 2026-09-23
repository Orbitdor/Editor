const API_ROOT = (
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000"
).replace(/\/+$/, "");

const BASE = `${API_ROOT}/api/documents`;

async function request(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

export function getDocs() {
  return request(BASE);
}

export function createDoc() {
  return request(BASE, { method: "POST" });
}

export function getDoc(id) {
  return request(`${BASE}/${id}`);
}

export function saveDoc(id, body) {
  return request(`${BASE}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}