import crypto from "node:crypto";
import { ApiError } from "../utils/ApiError.js";
import { googleConfig, isGoogleConfigured, GOOGLE_DOC_MIME, EXPORTED_HTML_MIME } from "../config/google.js";
import { docsToTiptap, isGoogleDoc } from "./google.docs.js";

/**
 * Google Drive browsing, import and export (master plan sections 30-31).
 *
 * Drive is reached with the narrow `drive.file` scope, which only grants access
 * to files this app created or the user explicitly opened with it. That is
 * strictly better than full Drive access and is why the scope is worth arguing
 * for on the consent screen.
 *
 * With no credentials the calls are served from a small in-memory fixture, so the
 * picker, the import pipeline and its limitation reporting are all testable
 * offline. Mock results are always labelled as such.
 */

/** Ceilings so a runaway import cannot exhaust the API quota. */
const MAX_LIST = 50;
const DEFAULT_LIMIT = 25;

/** The fixture Drive returned when no credentials are configured. */
const MOCK_FILES = [
  { id: "mock-doc-1", name: "Quarterly Report", mimeType: GOOGLE_DOC_MIME, modifiedTime: "2026-09-20T10:00:00Z", owners: [{ displayName: "You" }] },
  { id: "mock-doc-2", name: "Team Meeting Notes", mimeType: GOOGLE_DOC_MIME, modifiedTime: "2026-09-18T14:30:00Z", owners: [{ displayName: "You" }] },
  { id: "mock-doc-3", name: "Budget Spreadsheet", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-09-11T09:15:00Z", owners: [{ displayName: "You" }] },
  { id: "mock-doc-4", name: "Contract Draft", mimeType: GOOGLE_DOC_MIME, modifiedTime: "2026-08-30T16:45:00Z", owners: [{ displayName: "Sara" }] },
];

/** A Docs payload with one of each interesting construct. */
const MOCK_DOC = {
  title: "Quarterly Report",
  body: {
    content: [
      { paragraph: { paragraphStyle: { namedStyleType: "TITLE" }, elements: [{ textRun: { content: "Quarterly Report" } }] } },
      { paragraph: { paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, elements: [{ textRun: { content: "Revenue grew by 12 percent compared to last quarter and the team shipped every planned feature on time." } }] } },
      { paragraph: { paragraphStyle: { namedStyleType: "HEADING_2" }, elements: [{ textRun: { content: "Highlights" } }] } },
      { paragraph: { paragraphStyle: { namedStyleType: "BULLETED_LIST" }, elements: [{ textRun: { content: "Revenue up 12 percent" } }] } },
      { paragraph: { paragraphStyle: { namedStyleType: "BULLETED_LIST" }, elements: [{ textRun: { content: "All planned features shipped" } }] } },
      { paragraph: { paragraphStyle: { namedStyleType: "BULLETED_LIST" }, elements: [{ textRun: { content: "Two new enterprise customers" } }] } },
      { paragraph: { paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, elements: [{ textRun: { content: "Next quarter we plan to focus on the mobile experience and reduce churn." } }] } },
    ],
  },
};

/** True when the Drive/Docs calls should be faked. */
function useMock() {
  const cfg = googleConfig();
  return !isGoogleConfigured(cfg) && cfg.allowMock;
}

/** GET/POST to Google with a bearer token and a timeout. */
async function callGoogle(url, { method = "GET", accessToken, body, headers = {}, raw = false } = {}) {
  const cfg = googleConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 404 is a normal outcome for a file the user deleted, so it gets a
      // clearer message than the raw provider error.
      if (res.status === 404) throw new ApiError(404, "That file is no longer in Drive");
      if (res.status === 401 || res.status === 403) {
        throw new ApiError(403, "Google denied access to that file. Reconnect your account.", text.slice(0, 300));
      }
      throw new ApiError(502, `Google request failed (${res.status})`, text.slice(0, 500));
    }

    return raw ? res : res.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === "AbortError") throw new ApiError(504, "Google took too long to respond");
    throw new ApiError(502, "Could not reach Google", err.message);
  } finally {
    clearTimeout(timer);
  }
}

/** Human label for a Drive mime type. */
function kindOf(mimeType) {
  if (isGoogleDoc(mimeType)) return "doc";
  if (mimeType?.startsWith("application/vnd.google-apps.")) return "native";
  if (mimeType === "application/vnd.google-apps.folder") return "folder";
  return "file";
}

/** Shape a Drive file for the picker. */
function presentFile(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    kind: kindOf(file.mimeType),
    modifiedTime: file.modifiedTime,
    owner: file.owners?.[0]?.displayName || null,
    importable: isGoogleDoc(file.mimeType),
  };
}

/**
 * List candidate files for the import picker.
 *
 * Google Docs files are native Drive objects, so they are filtered out of the
 * generic listing and fetched by mime type instead.
 *
 * @param {string} accessToken
 * @param {{q?: string, limit?: number, cursor?: string}} [params]
 * @returns {Promise<{files: object[], nextCursor: string|null, mock: boolean}>}
 */
export async function listFiles(accessToken, { q = "", limit = DEFAULT_LIMIT, cursor = null } = {}) {
  const capped = Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIST);

  if (useMock()) {
    const needle = String(q).toLowerCase();
    const matched = MOCK_FILES.filter((f) => !needle || f.name.toLowerCase().includes(needle));
    return { files: matched.slice(0, capped).map(presentFile), nextCursor: null, mock: true };
  }

  const filters = [
    "trashed = false",
    // Native Google editor files have no downloadable bytes, so they are listed
    // separately below rather than mixed in with real files.
    `mimeType != '${GOOGLE_DOC_MIME}'`,
  ];
  if (q) filters.push(`name contains '${String(q).replace(/'/g, "\\'")}'`);

  const params = new URLSearchParams({
    pageSize: String(capped),
    fields: "nextPageToken, files(id,name,mimeType,modifiedTime,owners(displayName))",
    q: filters.join(" and "),
    orderBy: "modifiedTime desc",
  });
  if (cursor) params.set("pageToken", cursor);

  const data = await callGoogle(`${googleConfig().driveUrl}/files?${params}`, { accessToken });

  // Fetch the Google Docs separately, since the list query excludes them.
  const docsParams = new URLSearchParams({
    pageSize: String(capped),
    fields: "nextPageToken, files(id,name,mimeType,modifiedTime,owners(displayName))",
    q: `trashed = false and mimeType = '${GOOGLE_DOC_MIME}'${q ? ` and name contains '${String(q).replace(/'/g, "\\'")}'` : ""}`,
    orderBy: "modifiedTime desc",
  });
  const docsData = await callGoogle(`${googleConfig().driveUrl}/files?${docsParams}`, { accessToken });

  const files = [...(docsData.files || []), ...(data.files || [])]
    .map(presentFile)
    .sort((a, b) => String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || "")))
    .slice(0, capped);

  return { files, nextCursor: data.nextPageToken || docsData.nextPageToken || null, mock: false };
}

/**
 * Fetch a Drive file's metadata.
 *
 * @param {string} accessToken
 * @param {string} fileId
 * @returns {Promise<object|null>}
 */
export async function getFile(accessToken, fileId) {
  if (!fileId || !/^[a-zA-Z0-9_-]{1,200}$/.test(String(fileId))) {
    // A Drive id is a short opaque token; anything else is either a bug or an
    // attempt to smuggle a path or URL into the API.
    throw new ApiError(400, "Invalid Google file id");
  }

  if (useMock()) {
    const file = MOCK_FILES.find((f) => f.id === fileId);
    if (!file) throw new ApiError(404, "That file is no longer in Drive");
    return { ...presentFile(file), mock: true };
  }

  const params = new URLSearchParams({
    fields: "id,name,mimeType,modifiedTime,owners(displayName)",
  });
  const data = await callGoogle(`${googleConfig().driveUrl}/files/${fileId}?${params}`, { accessToken });
  return { ...presentFile(data), mock: false };
}

/**
 * Import a Google Doc and convert it to Tiptap JSON (master plan section 31).
 *
 * @param {string} accessToken
 * @param {string} fileId
 * @returns {Promise<{title: string, content: object, plainText: string, limitations: string[], source: object, mock: boolean}>}
 */
export async function importDoc(accessToken, fileId) {
  const file = await getFile(accessToken, fileId);

  if (!isGoogleDoc(file.mimeType)) {
    throw new ApiError(
      400,
      "Only Google Docs can be imported with their formatting. Other file types can be uploaded as attachments."
    );
  }

  const doc = useMock() ? MOCK_DOC : await callGoogle(`${googleConfig().docsUrl}/documents/${fileId}`, { accessToken });
  const converted = docsToTiptap(doc);

  return {
    ...converted,
    // The Doc's own title wins, but the file name is the fallback when the body
    // is empty and the API returned no title.
    title: doc.title || file.name,
    source: { fileId, name: file.name, modifiedTime: file.modifiedTime },
    mock: useMock(),
  };
}

/**
 * Export a document to Drive as HTML.
 *
 * Drive renders HTML into a native Google Doc on import, so the result opens in
 * Docs rather than as a raw file.
 *
 * @param {string} accessToken
 * @param {{title: string, html: string}} params
 * @returns {Promise<{fileId: string, name: string, url: string, mock: boolean}>}
 */
export async function exportDoc(accessToken, { title, html }) {
  if (!title || !String(title).trim()) throw new ApiError(400, "A document title is required");
  if (!html || !String(html).trim()) throw new ApiError(400, "There is nothing to export");

  const name = String(title).trim().slice(0, 200);
  const body = String(html);

  if (useMock()) {
    return {
      fileId: `mock-export-${crypto.randomBytes(6).toString("hex")}`,
      name,
      url: `https://docs.google.com/document/d/mock-${name.replace(/\s+/g, "-")}/edit`,
      mock: true,
    };
  }

  const boundary = `doc-editor-${crypto.randomBytes(12).toString("hex")}`;
  const metadata = { name, mimeType: EXPORTED_HTML_MIME };

  // Drive's multipart upload takes metadata and content in one request. The
  // `upload` path with `uploadType=multipart` is what converts the HTML into a
  // native Doc.
  const multipart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
    `${body}\r\n` +
    `--${boundary}--`;

  const data = await callGoogle(
    `${googleConfig().driveUrl}/files?uploadType=multipart&fields=id,name,webViewLink`,
    {
      method: "POST",
      accessToken,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipart,
    }
  );

  return { fileId: data.id, name: data.name, url: data.webViewLink || null, mock: false };
}
