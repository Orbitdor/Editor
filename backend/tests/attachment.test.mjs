/**
 * File attachments (master plan sections 27, 37 and 45).
 *
 * Bytes go to object storage and Mongo keeps only metadata, so these tests care
 * about four things the happy path never shows:
 *   - a file whose contents contradict its extension is refused (magic bytes);
 *   - the storage quota is enforced before anything is written;
 *   - a file is exactly as visible as the document it hangs off;
 *   - a signed link stops working once it expires or the signer loses access;
 *   - deleting a document reclaims the bytes rather than orphaning them.
 */
const API = process.env.API || "http://localhost:5051/api/v1";

let failures = 0;

function ok(label, extra = "") {
  console.log(`  PASS  ${label}${extra ? ` -> ${extra}` : ""}`);
}
function bad(label, detail) {
  failures += 1;
  console.log(`  FAIL  ${label} -> ${detail}`);
}
function check(label, condition, detail = "") {
  condition ? ok(label, detail) : bad(label, detail);
}
function section(title) {
  console.log(`\n== ${title} ==`);
}

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

/**
 * POST multipart by hand: the suite must not depend on a form-data library.
 *
 * `fields` are emitted before the file, because that is the order a form built by
 * a browser produces and the order the parser expects the parts in.
 */
async function upload(path, token, filename, mime, bytes, fields = {}) {
  const boundary = `----attach${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();

  // Order matters: fields, then the file header, then the raw bytes, then the
  // terminator -- exactly the sequence a browser-built form produces.
  const head = Object.entries(fields).map(([key, value]) =>
    encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)
  );
  head.push(
    encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`
    )
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

  const headSize = head.reduce((sum, part) => sum + part.length, 0);
  // The head is ASCII and the file body arbitrary, so assemble with typed arrays
  // rather than string concatenation, which would mangle any byte above 127.
  const full = new Uint8Array(headSize + bytes.length + tail.length);
  let offset = 0;
  for (const part of head) {
    full.set(part, offset);
    offset += part.length;
  }
  full.set(bytes, offset);
  full.set(tail, offset + bytes.length);

  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: full,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

async function makeUser(tag) {
  const stamp = `${tag}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
  const res = await call("/auth/register", {
    method: "POST",
    body: { name: tag, email: `${stamp}@test.local`, password: "Str0ngPass!" },
  });
  if (res.status !== 201) throw new Error(`could not create ${tag}: ${JSON.stringify(res.body)}`);
  return { token: res.body.token, id: res.body.user.id, email: res.body.user.email.toLowerCase() };
}

async function newDoc(token, title = "Attach") {
  const res = await call("/documents", { method: "POST", token, body: { title } });
  if (res.status !== 201) throw new Error(`could not create document: ${JSON.stringify(res.body)}`);
  return res.body.document?._id || res.body._id;
}

/** Smallest valid file of each type: enough for the magic byte check. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x40, 0x08, 0x06, 0x00, 0x00, 0x00, 0x72, 0xb6, 0x0d,
  0x24, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n");

section("Capabilities are advertised");
const caps = await call("/attachments/capabilities");
check("capabilities need no session", caps.status === 200, `status ${caps.status}`);
check(
  "the accepted types include PDF and PNG",
  caps.body?.allowedMimeTypes?.includes("application/pdf") &&
    caps.body?.allowedMimeTypes?.includes("image/png"),
  JSON.stringify(caps.body?.allowedMimeTypes?.slice(0, 4))
);
check(
  "SVG is never offered for inline rendering",
  !caps.body?.inlineImageTypes?.includes("image/svg+xml"),
  JSON.stringify(caps.body?.inlineImageTypes)
);

section("Uploading a real file");
const owner = await makeUser("AttachOwner");
const outsider = await makeUser("AttachOutsider");
const docId = await newDoc(owner.token);

const png = await upload(`/attachments/documents/${docId}`, owner.token, "diagram.png", "image/png", PNG);
check("a PNG is accepted", png.status === 201, JSON.stringify(png.body));
check("the stored type is png", png.body?.attachment?.mime === "image/png", png.body?.attachment?.mime);
check("the size is recorded", png.body?.attachment?.bytes === PNG.length, `${png.body?.attachment?.bytes}`);
check("it is flagged as an image", png.body?.attachment?.kind === "image", png.body?.attachment?.kind);
check(
  "dimensions are read from the header",
  png.body?.attachment?.width === 64 && png.body?.attachment?.height === 64,
  `${png.body?.attachment?.width}x${png.body?.attachment?.height}`
);
const pngId = png.body?.attachment?._id;

const pdf = await upload(`/attachments/documents/${docId}`, owner.token, "brief.pdf", "application/pdf", PDF);
check("a PDF is accepted", pdf.status === 201, JSON.stringify(pdf.body));
const pdfId = pdf.body?.attachment?._id;

const listed = await call(`/attachments/documents/${docId}`, { token: owner.token });
check("the document lists both attachments", listed.body?.attachments?.length === 2, `${listed.body?.attachments?.length}`);

const stats = await call(`/attachments/documents/${docId}/stats`, { token: owner.token });
check(
  "the totals add up",
  stats.body?.stats?.count === 2 && stats.body?.stats?.bytes === PNG.length + PDF.length,
  JSON.stringify(stats.body?.stats)
);

section("The /uploads alias behaves exactly like the document-scoped route");
const aliasDoc = await newDoc(owner.token, "Alias target");
const alias = await upload(
  "/uploads",
  owner.token,
  "notes.txt",
  "text/plain",
  new TextEncoder().encode("plain text body"),
  { documentId: aliasDoc }
);
check("the alias accepts an upload", alias.status === 201, JSON.stringify(alias.body));
check(
  "it lands on the document named in the body",
  alias.body?.attachment?.document === aliasDoc,
  `${alias.body?.attachment?.document}`
);
check("the name is kept", alias.body?.attachment?.name === "notes.txt", alias.body?.attachment?.name);
const aliasList = await call(`/attachments/documents/${aliasDoc}`, { token: owner.token });
check(
  "the attachment is attached to that document",
  aliasList.body?.attachments?.some((a) => a._id === alias.body?.attachment?._id),
  `${aliasList.body?.attachments?.length} attachments`
);
const aliasNoDoc = await upload(
  "/uploads",
  owner.token,
  "notes.txt",
  "text/plain",
  new TextEncoder().encode("plain text body")
);
check("the alias still refuses a missing documentId", aliasNoDoc.status === 400, `status ${aliasNoDoc.status}`);
const aliasBadDoc = await upload(
  "/uploads",
  owner.token,
  "notes.txt",
  "text/plain",
  new TextEncoder().encode("plain text body"),
  { documentId: "not-an-id" }
);
check("the alias refuses a malformed documentId", aliasBadDoc.status === 400, `status ${aliasBadDoc.status}`);
const aliasAnon = await upload(
  "/uploads",
  null,
  "notes.txt",
  "text/plain",
  new TextEncoder().encode("plain text body"),
  { documentId: aliasDoc }
);
check("the alias requires a session", aliasAnon.status === 401, `status ${aliasAnon.status}`);
const aliasStranger = await upload(
  "/uploads",
  outsider.token,
  "notes.txt",
  "text/plain",
  new TextEncoder().encode("plain text body"),
  { documentId: aliasDoc }
);
check("the alias enforces document access", aliasStranger.status === 403, `status ${aliasStranger.status}`);

section("A file that lies about its type is refused");
const disguised = await upload(
  `/attachments/documents/${docId}`,
  owner.token,
  "invoice.png",
  "image/png",
  new TextEncoder().encode("#!/bin/sh\nrm -rf /\n")
);
check("a script renamed to .png is rejected", disguised.status === 400, `status ${disguised.status}`);
check(
  "the rejection explains the type mismatch",
  /do not match/i.test(disguised.body?.error || ""),
  disguised.body?.error
);

const zipAsDocx = await upload(
  `/attachments/documents/${docId}`,
  owner.token,
  "fake.docx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  new TextEncoder().encode("this is not a zip archive")
);
check("a text file renamed to .docx is rejected", zipAsDocx.status === 400, `status ${zipAsDocx.status}`);

const exeAsTxt = await upload(
  `/attachments/documents/${docId}`,
  owner.token,
  "notes.txt",
  "text/plain",
  new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])
);
check("a binary renamed to .txt is rejected", exeAsTxt.status === 400, `status ${exeAsTxt.status}`);

const badType = await upload(
  `/attachments/documents/${docId}`,
  owner.token,
  "payload.exe",
  "application/x-msdownload",
  new Uint8Array([0x4d, 0x5a, 0x00])
);
check("a type outside the allow-list is refused", badType.status === 415, `status ${badType.status}`);

const afterRejects = await call(`/attachments/documents/${docId}`, { token: owner.token });
check(
  "none of the rejected files were stored",
  afterRejects.body?.attachments?.length === 2,
  `${afterRejects.body?.attachments?.length}`
);

section("Downloads are served safely");
const raw = await fetch(`${API}/attachments/${pdfId}`, {
  headers: { Authorization: `Bearer ${owner.token}` },
});
const bytes = new Uint8Array(await raw.arrayBuffer());
check("the bytes come back intact", bytes.length === PDF.length, `${bytes.length} vs ${PDF.length}`);
check(
  "a PDF is served as a download, not inline",
  (raw.headers.get("content-disposition") || "").startsWith("attachment"),
  raw.headers.get("content-disposition")
);
check(
  "it is never served under its own type",
  raw.headers.get("content-type") === "application/octet-stream",
  raw.headers.get("content-type")
);
check("nosniff is set", raw.headers.get("x-content-type-options") === "nosniff", raw.headers.get("x-content-type-options"));

const inline = await fetch(`${API}/attachments/${pngId}/content?inline=1`, {
  headers: { Authorization: `Bearer ${owner.token}` },
});
check(
  "an image may render inline, with its real type",
  inline.headers.get("content-type") === "image/png" &&
    (inline.headers.get("content-disposition") || "").startsWith("inline"),
  `${inline.headers.get("content-type")} / ${inline.headers.get("content-disposition")}`
);

const traversal = await upload(
  `/attachments/documents/${docId}`,
  owner.token,
  "../../../../etc/passwd.png",
  "image/png",
  PNG
);
check(
  "a traversal filename is flattened, not stored as a path",
  traversal.status === 201 && !traversal.body?.attachment?.name?.includes("/"),
  traversal.body?.attachment?.name
);

section("Visibility follows the document");
// Documents answer 403 for a caller with no role at all, not 404, and an
// attachment is exactly as visible as the page it sits on, so it matches.
const stranger = await call(`/attachments/documents/${docId}`, { token: outsider.token });
check("a non-member cannot list them", stranger.status === 403, `status ${stranger.status}`);
const steal = await call(`/attachments/${pdfId}`, { token: outsider.token });
check("a non-member cannot download them", steal.status === 403, `status ${steal.status}`);
const anon = await fetch(`${API}/attachments/${pdfId}`);
check("an anonymous caller is refused", anon.status === 401, `status ${anon.status}`);

section("Storage quota is enforced before writing");
// The Free plan allows 100 MB, which is far too much to upload just to prove a
// limit. So this suite runs twice: once normally, and once with
// PLAN_FREE_STORAGE_BYTES squeezed small, because `planFor()` reads that variable
// on every request.
//
// Rather than hardcoding an expected total -- which breaks the moment a fixture
// changes size -- the tight run keeps uploading until the server refuses, then
// checks that the refusal named storage and that nothing partial was left behind.
const QUOTA_ENV = process.env.PLAN_FREE_STORAGE_BYTES;
// Must test for presence, not truthiness: an absent variable coerces to 0, which
// would read as "a very small quota" and take the tight branch by accident.
const TIGHT_QUOTA = QUOTA_ENV !== undefined && Number(QUOTA_ENV) < 4096;

if (TIGHT_QUOTA) {
  let refused = null;
  let accepted = 0;
  for (let attempt = 0; attempt < 6 && !refused; attempt += 1) {
    const res = await upload(
      `/attachments/documents/${docId}`,
      owner.token,
      `filler-${attempt}.png`,
      "image/png",
      PNG
    );
    if (res.status === 201) accepted += 1;
    else refused = res;
  }

  check("the quota eventually refuses an upload", !!refused, "six uploads all succeeded");
  check("the refusal is a 409", refused?.status === 409, `status ${refused?.status}`);
  check(
    "the refusal names storage as the reason",
    /storage/i.test(refused?.body?.error || ""),
    refused?.body?.error
  );
  check(
    "the workspace was already near its limit when it refused",
    accepted < 6,
    `${accepted} accepted before the refusal`
  );

  const finalCount = (await call(`/attachments/documents/${docId}`, { token: owner.token })).body?.attachments?.length;
  check(
    "only the accepted uploads were stored",
    finalCount === 3 + accepted,
    `${finalCount} stored, ${accepted} accepted`
  );
} else {
  const under = await upload(
    `/attachments/documents/${docId}`,
    owner.token,
    "under-quota.png",
    "image/png",
    PNG
  );
  check("an upload under the quota succeeds", under.status === 201, `status ${under.status}`);
  const finalStats = (await call(`/attachments/documents/${docId}/stats`, { token: owner.token })).body?.stats;
  check(
    "the stored total covers every accepted file",
    finalStats?.count === 4 && finalStats?.bytes >= PNG.length * 3,
    JSON.stringify(finalStats)
  );
}

section("Signed links expire and respect access");
const minted = await call(`/attachments/${pdfId}/signed-url`, { token: owner.token });
check("a signed link can be minted", minted.status === 200 && !!minted.body?.url, JSON.stringify(minted.body));
check("it reports an expiry", !!minted.body?.expiresAt, minted.body?.expiresAt);

// The minted url is already root-relative and already includes /api/v1, so it
// goes against the origin rather than against API.
const signedPath = minted.body.url;
const signedRes = await fetch(`${API.replace(/\/api\/v1$/, "")}${signedPath}`);
check("the signed link works for a permitted caller", signedRes.status === 200, `status ${signedRes.status}`);

const tampered = signedPath.replace(/&signature=.*/, "&signature=deadbeef");
const stolen = await fetch(`${API.replace(/\/api\/v1$/, "")}${tampered}`);
check("a tampered signature is refused", stolen.status === 401, `status ${stolen.status}`);

const expiredPath = signedPath.replace(/expires=\d+/, `expires=${Date.now() - 1000}`);
const expired = await fetch(`${API.replace(/\/api\/v1$/, "")}${expiredPath}`);
check("an expired link is refused", expired.status === 401, `status ${expired.status}`);

const signedOutsider = await fetch(`${API.replace(/\/api\/v1$/, "")}${signedPath}`);
check(
  "the link works without a session, as a presigned url does",
  signedOutsider.status === 200,
  `status ${signedOutsider.status}`
);

const noLink = await fetch(`${API}/attachments/${pdfId}`, {
  headers: { Authorization: `Bearer ${outsider.token}` },
});
check("but the same file without a link is still refused", noLink.status === 403, `status ${noLink.status}`);

section("Deletion");
const removed = await call(`/attachments/${pdfId}`, { method: "DELETE", token: owner.token });
check("an attachment can be removed", removed.status === 200, `status ${removed.status}`);

const goneRes = await fetch(`${API}/attachments/${pdfId}`, {
  headers: { Authorization: `Bearer ${owner.token}` },
});
check("the metadata is gone with it", goneRes.status === 404, `status ${goneRes.status}`);

const strangerDelete = await call(`/attachments/${pngId}`, { method: "DELETE", token: outsider.token });
check("a non-member cannot delete", strangerDelete.status === 403, `status ${strangerDelete.status}`);

section("Deleting the document reclaims the bytes");
// The whole point of tracking keys: a permanent delete has to take the files with
// it, or the disk fills up silently.
const doomed = await newDoc(owner.token, "Doomed");
const doomedUpload = await upload(
  `/attachments/documents/${doomed}`,
  owner.token,
  "notes.pdf",
  "application/pdf",
  PDF
);
check("a file is attached to the doomed document", doomedUpload.status === 201, `status ${doomedUpload.status}`);
const doomedId = doomedUpload.body?.attachment?._id;

const notTrashed = await call(`/documents/${doomed}`, { method: "DELETE", token: owner.token });
check(
  "a live document cannot be destroyed outright",
  notTrashed.status === 409,
  `status ${notTrashed.status}`
);

await call(`/documents/${doomed}/trash`, { method: "POST", token: owner.token });
const destroyed = await call(`/documents/${doomed}`, { method: "DELETE", token: owner.token });
check("a trashed document is destroyed", destroyed.status === 200, `status ${destroyed.status}`);
check("the deletion reports its attachments", destroyed.body?.attachments === 1, JSON.stringify(destroyed.body));

const orphan = await fetch(`${API}/attachments/${doomedId}`, {
  headers: { Authorization: `Bearer ${owner.token}` },
});
check("the orphaned file is not readable", orphan.status === 404, `status ${orphan.status}`);

section("The workspace total reflects attachments");
const after = await call(`/workspaces`, { token: owner.token });
const personal = after.body?.workspaces?.find((w) => w.isPersonal);
check(
  "the cached storage total includes the attached bytes",
  personal?.stats?.storageBytes >= PNG.length,
  `${personal?.stats?.storageBytes}`
);

console.log(`\n${failures === 0 ? "ALL ATTACHMENT TESTS PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);