import { clearSession } from "@/lib/auth";

// Default to a same-origin relative path so `/api/*` goes through the Next.js
// rewrite proxy (see next.config.mjs). That keeps the HttpOnly session cookie
// first-party in every environment; set NEXT_PUBLIC_API_URL only to bypass the
// proxy and call an API host directly.
//
// A production build must never talk to localhost: a stale build-time value
// like that is exactly how a deployed app ends up firing at the visitor's own
// machine. Localhost is therefore ignored outside development.
const CONFIGURED_API_URL = (process.env.NEXT_PUBLIC_API_URL || "").trim();
const IS_LOCALHOST = /(^|\/\/)(localhost|127\.0\.0\.1)(:|\/|$)/.test(CONFIGURED_API_URL);
const API_ROOT = (
  process.env.NODE_ENV === "production" && IS_LOCALHOST ? "" : CONFIGURED_API_URL
).replace(/\/+$/, "");

const BASE = `${API_ROOT}/api/v1/documents`;
const AUTH = `${API_ROOT}/api/v1/auth`;
const NOTIFICATIONS = `${API_ROOT}/api/v1/notifications`;
const SHARED = `${API_ROOT}/api/v1/shared`;
const AI = `${API_ROOT}/api/v1/ai`;
const VOICE = `${API_ROOT}/api/v1/voice`;
const WORKSPACES = `${API_ROOT}/api/v1/workspaces`;
const FOLDERS = `${API_ROOT}/api/v1/folders`;
const ATTACHMENTS = `${API_ROOT}/api/v1/attachments`;
const TEMPLATES = `${API_ROOT}/api/v1/templates`;

/**
 * Every call carries the session cookies. The access token inside is HttpOnly, so
 * there is no Authorization header to build any more.
 */
const WITH_COOKIES = { credentials: "include" };

/**
 * One in-flight refresh at a time, shared by every caller. Without this, a
 * dashboard firing six parallel requests on an expired token would send six
 * refreshes, and rotation would treat the last five as a replay and kill the
 * session it just created.
 */
let refreshing = null;

async function refreshSession() {
  if (!refreshing) {
    refreshing = fetch(`${AUTH}/refresh`, { method: "POST", ...WITH_COOKIES }).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function request(url, options = {}, retried = false) {
  const res = await fetch(url, { ...WITH_COOKIES, ...options });

  // An expired access token is not an error the user should see: renew it once
  // and replay the original request.
  if (res.status === 401 && !retried && !url.includes("/auth/")) {
    const renewed = await refreshSession().catch(() => null);
    if (renewed?.ok) return request(url, options, true);
    clearSession();
  }

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

/** Sign out this device; the server revokes the refresh token it was given. */
export async function logout() {
  await fetch(`${AUTH}/logout`, { method: "POST", ...WITH_COOKIES }).catch(() => null);
}

/** Every live session for the account, for the "your devices" screen. */
export async function getSessions() {
  return request(`${AUTH}/sessions`);
}

/**
 * A short-lived token for the notification WebSocket.
 *
 * The socket is opened against the API host directly, which is a different origin
 * from the one that holds the session cookie, so the cookie cannot ride along.
 * This same-origin call mints a token the socket can present instead.
 */
export async function getSocketToken() {
  return request(`${AUTH}/socket-token`);
}

/** Revoke one device by id. */
export async function revokeSession(sessionId) {
  return request(`${AUTH}/sessions/${sessionId}`, { method: "DELETE" });
}

/** Revoke every session, everywhere. */
export async function logoutAll() {
  return request(`${AUTH}/logout-all`, { method: "POST" });
}

export async function registerUser(name, email, password) {
  const res = await fetch(`${AUTH}/register`, {
    method: "POST",
    headers: JSON_HEADERS,
    ...WITH_COOKIES,
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
    ...WITH_COOKIES,
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
  if (params.workspaceId) qs.set("workspaceId", params.workspaceId);
  if (params.folderId) qs.set("folderId", params.folderId);
  // "Unfiled" is an explicit ask, because an absent folderId means "every folder".
  if (params.unfiled) qs.set("unfiled", "true");
  const q = qs.toString();
  return request(q ? `${BASE}?${q}` : BASE);
}

export function createDoc(body = {}) {
  return request(BASE, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function getDoc(id) {
  return request(`${BASE}/${id}`);
}

// ---------------------------------------------------------------------------
// Folders (master plan section 11)
// ---------------------------------------------------------------------------

/** The folder tree for one workspace, top level first with nested children. */
export function getFolders(params = {}) {
  const qs = new URLSearchParams();
  if (params.workspaceId) qs.set("workspaceId", params.workspaceId);
  const q = qs.toString();
  return request(`${FOLDERS}${q ? `?${q}` : ""}`);
}

export function getTrashedFolders(params = {}) {
  const qs = new URLSearchParams();
  if (params.workspaceId) qs.set("workspaceId", params.workspaceId);
  const q = qs.toString();
  return request(`${FOLDERS}/trash${q ? `?${q}` : ""}`);
}

export function createFolder(body) {
  return request(FOLDERS, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

export function updateFolder(id, patch) {
  return request(`${FOLDERS}/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
}

export function trashFolder(id) {
  return request(`${FOLDERS}/${id}`, { method: "DELETE" });
}

export function restoreFolder(id) {
  return request(`${FOLDERS}/${id}/restore`, { method: "POST" });
}

export function deleteFolderForever(id) {
  return request(`${FOLDERS}/${id}/permanent`, { method: "DELETE" });
}

// Attachments (master plan section 27)

/** What the attach button accepts, so it can filter the file picker up front. */
export function getAttachmentCapabilities() {
  return request(`${ATTACHMENTS}/capabilities`);
}

export function getAttachments(docId) {
  return request(`${ATTACHMENTS}/documents/${docId}`);
}

export function getAttachmentStats(docId) {
  return request(`${ATTACHMENTS}/documents/${docId}/stats`);
}

/**
 * Upload a file as multipart. `request` speaks JSON, and an upload has to be
 * FormData so the browser sets the boundary itself.
 */
export async function uploadAttachment(docId, file) {
  const form = new FormData();
  form.append("file", file);
  return request(`${ATTACHMENTS}/documents/${docId}`, { method: "POST", body: form });
}

/**
 * Upload an image and get back a URL that can be used straight away in an `<img>`.
 */
export async function uploadAttachmentImage(docId, file) {
  const form = new FormData();
  form.append("file", file);
  return request(`${ATTACHMENTS}/documents/${docId}/image`, { method: "POST", body: form });
}

export function deleteAttachment(id) {
  return request(`${ATTACHMENTS}/${id}`, { method: "DELETE" });
}

/** Mint a short-lived link, for sharing a file outside the workspace. */
export function mintAttachmentUrl(id) {
  return request(`${ATTACHMENTS}/${id}/signed-url`);
}

/**
 * A URL an `<img>` or a download link can open.
 *
 * The plain content route works because the browser sends the session cookie,
 * which is why there is no token in the query string.
 */
export function attachmentContentUrl(id, { inline = false } = {}) {
  return `${ATTACHMENTS}/${id}/content${inline ? "?inline=1" : ""}`;
}

/** File a document into a folder, or unfile it with `folderId: null`. */
export function moveDocToFolder(docId, folderId) {
  return request(`${FOLDERS}/documents/${docId}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ folderId: folderId ?? null }),
  });
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

/**
 * Export formats the server understands. The extension is a fallback only: the
 * filename in `Content-Disposition` is authoritative, which is what keeps a new
 * format from being saved with the wrong extension when the menu is not updated
 * in step with the server.
 */
const EXPORT_EXTENSIONS = {
  markdown: "md",
  html: "html",
  txt: "txt",
  pdf: "pdf",
  docx: "docx",
};

function exportedFilename(res, format) {
  const header = res.headers.get("content-disposition") || "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return `document.${EXPORT_EXTENSIONS[format] || "txt"}`;
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
  return { blob: await res.blob(), filename: exportedFilename(res, format) };
}

/**
 * Collaboration: comments
 */

// GET /documents/:id/comments -> thread roots with nested replies
export function getComments(id) {
  return request(`${BASE}/${id}/comments`);
}

// POST /documents/:id/comments -> create a thread anchored to a text range
export function createComment(id, body) {
  return request(`${BASE}/${id}/comments`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

// POST /documents/:id/comments/:commentId/replies
export function replyToComment(id, commentId, body) {
  return request(`${BASE}/${id}/comments/${commentId}/replies`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ body }),
  });
}

// PATCH /documents/:id/comments/:commentId
export function editComment(id, commentId, body) {
  return request(`${BASE}/${id}/comments/${commentId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ body }),
  });
}

// POST /documents/:id/comments/:commentId/resolve
export function resolveComment(id, commentId, resolved) {
  return request(`${BASE}/${id}/comments/${commentId}/resolve`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ resolved }),
  });
}

// DELETE /documents/:id/comments/:commentId
export function deleteComment(id, commentId) {
  return request(`${BASE}/${id}/comments/${commentId}`, { method: "DELETE" });
}

/**
 * Collaboration: sharing and permissions
 */

// GET /documents/:id/share -> owner, my role, share list
export function getShareState(id) {
  return request(`${BASE}/${id}/share`);
}

// PUT /documents/:id/share -> add or update one person's role
export function upsertShare(id, email, role) {
  return request(`${BASE}/${id}/share`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, role }),
  });
}

// DELETE /documents/:id/share/:userId
export function removeShare(id, userId) {
  return request(`${BASE}/${id}/share/${userId}`, { method: "DELETE" });
}

// GET /documents/:id/access -> { role, canEdit, canComment, canShare }
export function getAccess(id) {
  return request(`${BASE}/${id}/access`);
}

/**
 * "Anyone with the link" (master plan section 21).
 *
 * The server caps a link at `commenter`, so the role list here is deliberately
 * shorter than the per-person list: offering `editor` would only produce a
 * confusing refusal.
 */
export const LINK_ROLE_OPTIONS = [
  { value: "viewer", label: "Can view" },
  { value: "commenter", label: "Can comment" },
];

// GET /documents/:id/link -> { documentId, link: { enabled, role, token, url, expiresAt } }
export function getLinkShare(id) {
  return request(`${BASE}/${id}/link`);
}

// PUT /documents/:id/link -> turn the link on, or change its role or expiry
export function updateLinkShare(id, body) {
  return request(`${BASE}/${id}/link`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

// DELETE /documents/:id/link -> withdraw it for good
export function revokeLinkShare(id) {
  return request(`${BASE}/${id}/link`, { method: "DELETE" });
}

/**
 * Read a document through a public link.
 *
 * This is the only unauthenticated call in the app, so it uses `fetch` directly
 * rather than the cookie-carrying `request` helper, and it reads the body once:
 * a link visitor has no session to refresh.
 */
export async function openSharedLink(token) {
  const res = await fetch(`${API_ROOT}/shared/${encodeURIComponent(token)}`, {
    headers: { Accept: "application/json" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.error || `This link could not be opened (${res.status})`);
  }
  return body;
}

/** The URL behind a link, as an absolute address for sharing and copying. */
export function sharedLinkUrl(pathOrToken) {
  const token = String(pathOrToken).replace(/^\/shared\//, "");
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/shared/${token}`;
}

// GET /shared -> documents other people shared with me
export function getSharedWithMe() {
  return request(SHARED);
}

/**
 * Workspaces, membership, plans and the audit log (master plan sections 36, 46, 49)
 */

// GET /workspaces -> { workspaces: [...] } (creates the personal one if missing)
export function getWorkspaces() {
  return request(WORKSPACES);
}

// GET /workspaces/plans -> { plans, billingEnabled, current }
export function getPlans() {
  return request(`${WORKSPACES}/plans`);
}

// POST /workspaces -> { name }
export function createWorkspace(name) {
  return request(WORKSPACES, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
}

// GET /workspaces/:id -> workspace plus myRole, limits and (for admins) members
export function getWorkspace(id) {
  return request(`${WORKSPACES}/${id}`);
}

// PATCH /workspaces/:id -> { name }
export function renameWorkspace(id, name) {
  return request(`${WORKSPACES}/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
}

// POST /workspaces/:id/plan -> { plan } (refused unless billing is enabled)
export function changeWorkspacePlan(id, plan) {
  return request(`${WORKSPACES}/${id}/plan`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ plan }),
  });
}

// DELETE /workspaces/:id -> move to trash (owner only)
export function trashWorkspace(id) {
  return request(`${WORKSPACES}/${id}`, { method: "DELETE" });
}

// POST /workspaces/:id/restore
export function restoreWorkspace(id) {
  return request(`${WORKSPACES}/${id}/restore`, { method: "POST" });
}

// POST /workspaces/:id/leave
export function leaveWorkspace(id) {
  return request(`${WORKSPACES}/${id}/leave`, { method: "POST" });
}

// GET /workspaces/:id/members
export function getWorkspaceMembers(id) {
  return request(`${WORKSPACES}/${id}/members`);
}

// POST /workspaces/:id/members -> { email, role }
export function inviteWorkspaceMember(id, email, role = "member") {
  return request(`${WORKSPACES}/${id}/members`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, role }),
  });
}

// PATCH /workspaces/:id/members/:memberId -> { role }
export function setWorkspaceMemberRole(id, memberId, role) {
  return request(`${WORKSPACES}/${id}/members/${memberId}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ role }),
  });
}

// DELETE /workspaces/:id/members/:memberId
export function removeWorkspaceMember(id, memberId) {
  return request(`${WORKSPACES}/${id}/members/${memberId}`, { method: "DELETE" });
}

// POST /workspaces/:id/transfer -> { memberId }
export function transferWorkspace(id, memberId) {
  return request(`${WORKSPACES}/${id}/transfer`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ memberId }),
  });
}

// GET /workspaces/:id/activity?limit=&before=&action= -> { entries, nextCursor }
export function getWorkspaceActivity(id, { limit = 50, before = "", action = "" } = {}) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (before) qs.set("before", before);
  if (action) qs.set("action", action);
  return request(`${WORKSPACES}/${id}/activity?${qs}`);
}

// GET /workspaces/:id/activity/summary -> { days, actions: [{ action, count }] }
export function getWorkspaceActivitySummary(id, days = 30) {
  return request(`${WORKSPACES}/${id}/activity/summary?days=${days}`);
}

/**
 * Notifications and mentions
 */

// GET /notifications -> { items, unread }
export function getNotifications(limit = 30) {
  return request(`${NOTIFICATIONS}?limit=${limit}`);
}

// POST /notifications/read -> mark specific ids (or all when omitted) as read
export function markNotificationsRead(ids = null) {
  return request(`${NOTIFICATIONS}/read`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(ids ? { ids } : {}),
  });
}

// GET /notifications/mention-search?q= -> @mention autocomplete
export function searchMentionUsers(query = "", limit = 8) {
  const qs = new URLSearchParams({ q: query, limit: String(limit) });
  return request(`${NOTIFICATIONS}/mention-search?${qs}`);
}

/**
 * AI writing assistant and OCR
 */

// GET /ai/status -> { provider, configured, mock, actions, languages, tones }
export function getAiStatus() {
  return request(`${AI}/status`);
}

// GET /ai/usage -> { day: { requests, limit }, month: { requests, limit } }
export function getAiUsage() {
  return request(`${AI}/usage`);
}

/**
 * POST /documents/:id/ai/action -> run a writing action.
 *
 * `selection` is the highlighted text; when omitted the server falls back to the
 * whole document for document-level actions like summarize or extract-tasks.
 */
export function runAiAction(id, { action, text, selection, tone, language }) {
  return request(`${BASE}/${id}/ai/action`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ action, text, selection, tone, language }),
  });
}

// POST /documents/:id/ai/ask -> free-form question about the document
export function askAboutDocument(id, question, language = "en") {
  return request(`${BASE}/${id}/ai/ask`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ question, language }),
  });
}

// POST /documents/:id/ocr -> extract text from a base64 image
export function runOcr(id, image, language = "auto") {
  return request(`${BASE}/${id}/ocr`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ image, language }),
  });
}

// GET /documents/:id/ocr -> recent OCR jobs
export function getOcrJobs(id, limit = 10) {
  return request(`${BASE}/${id}/ocr?limit=${limit}`);
}

/**
 * Voice dictation
 */

// GET /voice/status -> provider capability + remaining daily minutes
export function getVoiceStatus() {
  return request(`${VOICE}/status`);
}

// POST /documents/:id/voice/transcribe -> server-side speech-to-text
export function transcribeAudio(id, audio, { language = "auto", durationSeconds = 0 } = {}) {
  return request(`${BASE}/${id}/voice/transcribe`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ audio, language, durationSeconds }),
  });
}

// POST /documents/:id/voice/finish -> clean up a browser-side transcript
export function finishDictation(id, transcript, { language = "auto", durationSeconds = 0 } = {}) {
  return request(`${BASE}/${id}/voice/finish`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ transcript, language, durationSeconds, provider: "browser" }),
  });
}

// GET /documents/:id/voice -> recent dictation sessions
export function getVoiceSessions(id, limit = 10) {
  return request(`${BASE}/${id}/voice?limit=${limit}`);
}

/**
 * Google integration (master plan sections 29-31)
 */

const GOOGLE = `${API_ROOT}/api/v1/integrations/google`;

// GET /integrations/google/status -> capability + the current connection
export function getGoogleStatus() {
  return request(`${GOOGLE}/status`);
}

// GET /integrations/google/start -> the consent URL for the requested permissions
export function startGoogleConnect(groups = ["drive", "docs"]) {
  const query = encodeURIComponent(groups.join(","));
  return request(`${GOOGLE}/start?groups=${query}`);
}

// DELETE /integrations/google -> revoke the grant and forget it
export function disconnectGoogle() {
  return request(`${GOOGLE}`, { method: "DELETE" });
}

// GET /integrations/google/files -> Drive files for the import picker
export function listGoogleFiles({ q = "", limit = 25, cursor = "" } = {}) {
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return request(`${GOOGLE}/files?${params.toString()}`);
}

// GET /integrations/google/files/:fileId -> a Google Doc converted to Tiptap
export function importGoogleFile(fileId) {
  return request(`${GOOGLE}/files/${encodeURIComponent(fileId)}`);
}

// POST /integrations/google/export -> upload the document to Drive
export function exportToGoogleDrive(title, html) {
  return request(`${GOOGLE}/export`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title, html }),
  });
}

// GET /auth/google/start -> the sign-in consent URL
export function startGoogleSignIn() {
  return request(`${AUTH}/google/start`);
}

// POST /auth/google/session -> trade the callback ticket for the JWT
export function completeGoogleSignIn(ticket) {
  return request(`${AUTH}/google/session`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ticket }),
  });
}

/**
 * Templates (master plan sections 32 and 33)
 *
 * The browse response omits each template's body to keep the grid light; the single
 * template endpoint is what fills that in, and `content` is present there.
 */

/** The built-in library plus the caller's workspace templates. */
export function getTemplates(params = {}) {
  const qs = new URLSearchParams();
  if (params.workspaceId) qs.set("workspaceId", params.workspaceId);
  if (params.category) qs.set("category", params.category);
  if (params.q) qs.set("q", params.q);
  const q = qs.toString();
  return request(`${TEMPLATES}${q ? `?${q}` : ""}`);
}

/** One template with its body and the placeholders found in it. */
export function getTemplate(id, params = {}) {
  const qs = new URLSearchParams();
  if (params.workspaceId) qs.set("workspaceId", params.workspaceId);
  const q = qs.toString();
  return request(`${TEMPLATES}/${id}${q ? `?${q}` : ""}`);
}

/** The one-off "create a proposal"-style prompts offered by smart templates. */
export function getSmartPrompts() {
  return request(`${TEMPLATES}/smart/prompts`);
}

/** Create a document from a template, merging any field values into the body. */
export function createDocFromTemplate(id, body = {}) {
  return request(`${TEMPLATES}/${id}/use`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Freeze an existing document as a workspace template. */
export function saveTemplateFromDocument(body) {
  return request(`${TEMPLATES}/from-document`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Edit a workspace template. Built-ins are refused by the API. */
export function updateTemplate(id, patch) {
  return request(`${TEMPLATES}/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
}

/** Delete a workspace template. */
export function deleteTemplate(id, params = {}) {
  const qs = new URLSearchParams();
  if (params.workspaceId) qs.set("workspaceId", params.workspaceId);
  const q = qs.toString();
  return request(`${TEMPLATES}/${id}${q ? `?${q}` : ""}`, { method: "DELETE" });
}

/**
 * Ask the AI for a template structure (master plan section 33).
 *
 * `save: false` returns a draft to preview instead of writing it into the
 * workspace, which is what the picker uses until the user accepts it.
 */
export function generateTemplate(body) {
  return request(`${TEMPLATES}/generate`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/**
 * Read a picked image file as a base64 data URL.
 *
 * The API accepts a data URL rather than a multipart body, which keeps the OCR
 * route free of extra middleware. The file is re-encoded through a canvas to
 * strip EXIF and to cap very large photos before they cross the network.
 *
 * @param {File} file
 * @param {{maxEdge?: number, quality?: number}} opts
 * @returns {Promise<string>} data URL
 */
export function fileToDataUrl(file, { maxEdge = 2000, quality = 0.9 } = {}) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type?.startsWith("image/")) {
      reject(new Error("Please choose an image file"));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That image could not be decoded"));
      img.onload = () => {
        // Downscale only when the image is larger than the cap; a small image
        // is re-encoded as-is so text stays crisp.
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const width = Math.round(img.width * scale);
        const height = Math.round(img.height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}