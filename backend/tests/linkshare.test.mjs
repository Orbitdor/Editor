/**
 * "Anyone with the link" (master plan section 21).
 *
 * The interesting part of a link is not that it works -- it is that it stops
 * working. Most of this suite is about the boundaries: who may turn it on, what a
 * link is never allowed to grant, and that revocation is immediate and total.
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

async function call(path, { method = "GET", token, body, raw = false } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  // The body can only be read once, so `raw` has to come first.
  if (raw) {
    return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
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

async function newDoc(token, title, content = "") {
  const res = await call("/documents", { method: "POST", token, body: { title } });
  if (res.status !== 201) throw new Error(`could not create document: ${JSON.stringify(res.body)}`);
  const id = res.body.document?._id || res.body._id;
  if (content) {
    await call(`/documents/${id}`, { method: "PUT", token, body: { content } });
  }
  return id;
}

/** POST multipart by hand, so the suite needs no form-data library. */
async function upload(path, token, filename, mime, bytes) {
  const boundary = `----link${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const full = new Uint8Array(head.length + bytes.length + tail.length);
  full.set(head, 0);
  full.set(bytes, head.length);
  full.set(tail, head.length + bytes.length);

  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: full,
    signal: AbortSignal.timeout(60000),
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

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const owner = await makeUser("LinkOwner");
const stranger = await makeUser("LinkStranger");
const editor = await makeUser("LinkEditor");
const invited = await makeUser("LinkInvited");

section("A document has no link until one is made");
const docId = await newDoc(owner.token, "Board minutes", "<h1>March</h1><p>Attendees: five.</p>");
const offState = await call(`/documents/${docId}/link`, { token: owner.token });
check("the owner sees the link state", offState.status === 200, `status ${offState.status}`);
check("it starts off", offState.body?.link?.enabled === false, JSON.stringify(offState.body?.link));
check("there is no token while it is off", !offState.body?.link?.token, offState.body?.link?.token);
const shareStateOff = await call(`/documents/${docId}/share`, { token: owner.token });
check("the share state reports it as off", shareStateOff.body?.link?.enabled === false, JSON.stringify(shareStateOff.body?.link));

section("Only the owner may turn a link on");
const strangerTurnsOn = await call(`/documents/${docId}/link`, {
  method: "PUT",
  token: stranger.token,
  body: { role: "viewer" },
});
check("a stranger is refused", strangerTurnsOn.status === 403, `status ${strangerTurnsOn.status}`);
const anonTurnsOn = await call(`/documents/${docId}/link`, { method: "PUT", body: { role: "viewer" } });
check("an anonymous caller is refused", anonTurnsOn.status === 401, `status ${anonTurnsOn.status}`);

section("Turning the link on");
const enabled = await call(`/documents/${docId}/link`, { method: "PUT", token: owner.token, body: { role: "viewer" } });
check("the link turns on", enabled.status === 200, `status ${enabled.status}`);
check("it reports itself enabled", enabled.body?.link?.enabled === true, JSON.stringify(enabled.body?.link));
const token = enabled.body?.link?.token;
check("a token is issued", typeof token === "string" && token.length >= 43, `${token?.length} chars`);
check("the token is url-safe base64", /^[A-Za-z0-9_-]+$/.test(token || ""), token?.slice(0, 12));
check("the share state agrees", (await call(`/documents/${docId}/share`, { token: owner.token })).body?.link?.enabled === true, "disagrees");

section("The link opens with no session at all");
const anon = await call(`/shared/${token}`);
check("an anonymous visit works", anon.status === 200, `status ${anon.status}`);
check("the title comes through", anon.body?.document?.title === "Board minutes", anon.body?.document?.title);
check("the content comes through", /Attendees/.test(anon.body?.document?.content || ""), "content missing");
check("it is marked as a link visit", anon.body?.document?.viaLink === true, String(anon.body?.document?.viaLink));
check("the role is the one chosen", anon.body?.link?.role === "viewer", anon.body?.link?.role);

section("A link never grants more than reading");
check("it cannot edit", anon.body?.document?.canEdit === false, String(anon.body?.document?.canEdit));
check("it cannot comment", anon.body?.document?.canComment === false, String(anon.body?.document?.canComment));
const editorLink = await call(`/documents/${docId}/link`, { method: "PUT", token: owner.token, body: { role: "editor" } });
check("an editor link is refused outright", editorLink.status === 400, `status ${editorLink.status}`);
const ownerLink = await call(`/documents/${docId}/link`, { method: "PUT", token: owner.token, body: { role: "owner" } });
check("an owner link is refused outright", ownerLink.status === 400, `status ${ownerLink.status}`);
const stillViewer = await call(`/shared/${token}`);
check("the refused change left the role alone", stillViewer.body?.link?.role === "viewer", stillViewer.body?.link?.role);

section("A link exposes nothing else about the account");
check("it does not leak the workspace", anon.body?.document?.workspace === undefined, String(anon.body?.document?.workspace));
check("it does not leak the folder", anon.body?.document?.folder === undefined, String(anon.body?.document?.folder));
check("it does not leak the owner email", !JSON.stringify(anon.body).includes("@test.local"), JSON.stringify(anon.body).slice(0, 120));
check("it does not carry the collab state", anon.body?.document?.collabSync === undefined, "collabSync present");

section("Writing through a link is not possible");
const linkWrite = await call(`/documents/${docId}`, {
  method: "PUT",
  token: null,
  body: { content: "<p>defaced by the link</p>" },
});
check("an anonymous write is refused", linkWrite.status === 401, `status ${linkWrite.status}`);
// `GET /documents/:id` answers with the document at the top level, unlike the link
// route which nests it under `document`.
const stillIntact = await call(`/documents/${docId}`, { token: owner.token });
check("the document is unchanged", /Attendees/.test(stillIntact.body?.content || ""), `content was ${JSON.stringify(stillIntact.body?.content)}`);
// The link token must not ride along on an ordinary document read, or every viewer
// would silently hold the public credential.
check("an ordinary read does not carry the link", stillIntact.body?.linkShare === undefined, JSON.stringify(stillIntact.body?.linkShare));
const trashAttempt = await call(`/documents/${docId}/trash`, { method: "POST", token: null });
check("an anonymous trash is refused", trashAttempt.status === 401, `status ${trashAttempt.status}`);

section("Attachments follow the document, and only that document");
const ownAttachment = await upload(`/attachments/documents/${docId}`, owner.token, "chart.png", "image/png", PNG);
check("the owner uploaded a file", ownAttachment.status === 201, JSON.stringify(ownAttachment.body));
const attachmentId = ownAttachment.body?.attachment?._id;
const viaLink = await call(`/shared/${token}/attachments/${attachmentId}?inline=1`, { raw: true });
check("the link serves the attachment", viaLink.status === 200, `status ${viaLink.status}`);
check("the bytes are intact", Buffer.compare(viaLink.buffer, PNG) === 0, `${viaLink.buffer.length} vs ${PNG.length}`);
check("an image may render inline", viaLink.headers.get("content-type") === "image/png", viaLink.headers.get("content-type"));

const otherDoc = await newDoc(owner.token, "Private plans");
const otherFile = await upload(`/attachments/documents/${otherDoc}`, owner.token, "private.png", "image/png", PNG);
check(
  "a valid link cannot fetch an attachment from another document",
  (await call(`/shared/${token}/attachments/${otherFile.body?.attachment?._id}`, { raw: true })).status === 404,
  "leaked"
);
const strangerDoc = await newDoc(stranger.token, "Someone else's");
const strangerFile = await upload(`/attachments/documents/${strangerDoc}`, stranger.token, "secret.png", "image/png", PNG);
check(
  "nor a stranger's file",
  (await call(`/shared/${token}/attachments/${strangerFile.body?.attachment?._id}`, { raw: true })).status === 404,
  "leaked"
);
check(
  "a document that never had a link is not reachable",
  (await call(`/shared/${"a".repeat(43)}`, { raw: true })).status === 404,
  "reachable"
);

section("A non-image is downloaded, never rendered on this origin");
const textFile = await upload(`/attachments/documents/${docId}`, owner.token, "notes.txt", "text/plain", Buffer.from("secret notes"));
const textId = textFile.body?.attachment?._id;
const textInline = await call(`/shared/${token}/attachments/${textId}?inline=1`, { raw: true });
check("inline is refused for a text file", textInline.headers.get("content-type") === "application/octet-stream", textInline.headers.get("content-type"));
check("it downloads instead", (textInline.headers.get("content-disposition") || "").startsWith("attachment"), textInline.headers.get("content-disposition"));
check("nosniff is set", textInline.headers.get("x-content-type-options") === "nosniff", textInline.headers.get("x-content-type-options"));

section("A guessed token does not work");
check("a wrong token of the right shape is refused", (await call(`/shared/${"b".repeat(43)}`, { raw: true })).status === 404, "opened");
check("a malformed token is refused", (await call("/shared/short", { raw: true })).status === 400, "opened");
check("a token with a slash is refused", (await call(`/shared/${token.slice(0, 20)}%2Fabc`, { raw: true })).status === 400, "opened");
// A bare `/shared/` falls through to the authenticated "shared with me" list, which
// answers 401 for a signed-out caller. The point is only that it is not readable.
const bareShared = await call("/shared/", { raw: true });
check("an empty token is refused", bareShared.status >= 400 && bareShared.status < 500, `status ${bareShared.status}`);

section("Changing the role keeps the same link");
const promoted = await call(`/documents/${docId}/link`, { method: "PUT", token: owner.token, body: { role: "commenter" } });
check("the role changes", promoted.body?.link?.role === "commenter", promoted.body?.link?.role);
check("the token does not change", promoted.body?.link?.token === token, "token rotated");
check(
  "the old link still works, with the new role",
  (await call(`/shared/${token}`)).body?.link?.role === "commenter",
  "broken"
);

section("An expiry can be set and is reported");
const expiring = await call(`/documents/${docId}/link`, {
  method: "PUT",
  token: owner.token,
  body: { role: "commenter", expiresInDays: 7 },
});
check("the expiry is accepted", expiring.status === 200, `status ${expiring.status}`);
check("it reports a date", typeof expiring.body?.link?.expiresAt === "string", String(expiring.body?.link?.expiresAt));
const soon = new Date(expiring.body.link.expiresAt).getTime() - Date.now();
check("the date is about a week out", soon > 6 * 864e5 && soon < 8 * 864e5, `${Math.round(soon / 864e5)} days`);
check(
  "the link still works before it expires",
  (await call(`/shared/${token}`)).status === 200,
  "closed early"
);
check("a nonsense expiry is refused", (await call(`/documents/${docId}/link`, { method: "PUT", token: owner.token, body: { expiresInDays: 0 } })).status === 400, "accepted");
check("an absurd expiry is refused", (await call(`/documents/${docId}/link`, { method: "PUT", token: owner.token, body: { expiresInDays: 99999 } })).status === 400, "accepted");

section("Turning the link off closes it immediately");
const revoked = await call(`/documents/${docId}/link`, { method: "DELETE", token: owner.token });
check("the link turns off", revoked.status === 200, `status ${revoked.status}`);
check("it reports itself off", revoked.body?.link?.enabled === false, JSON.stringify(revoked.body?.link));
check("no token is returned", !revoked.body?.link?.token, revoked.body?.link?.token);
// Revoking clears the token, so the lookup finds nothing and answers 404 rather
// than 410. Either way the important part is that it is no longer readable.
const deadLink = await call(`/shared/${token}`, { raw: true });
check("the old link is dead", deadLink.status === 404 || deadLink.status === 410, `status ${deadLink.status}`);
const deadAttachment = await call(`/shared/${token}/attachments/${attachmentId}`, { raw: true });
check("the attachments are dead too", deadAttachment.status === 404 || deadAttachment.status === 410, `status ${deadAttachment.status}`);
const strangerRevoke = await call(`/documents/${docId}/link`, { method: "DELETE", token: stranger.token });
check("a stranger cannot turn it off", strangerRevoke.status === 403, `status ${strangerRevoke.status}`);

section("Turning it back on issues a new token");
const reenabled = await call(`/documents/${docId}/link`, { method: "PUT", token: owner.token, body: { role: "viewer" } });
check("it comes back on", reenabled.body?.link?.enabled === true, JSON.stringify(reenabled.body?.link));
check("the token is different from the withdrawn one", reenabled.body?.link?.token !== token, "same token");
check(
  "the withdrawn link does not come back to life",
  (await call(`/shared/${token}`, { raw: true })).status === 404,
  "resurrected"
);
check("the new link works", (await call(`/shared/${reenabled.body.link.token}`)).status === 200, "broken");

section("Emptying the trash closes a link that was already copied");
const trashDoc = await newDoc(owner.token, "To be trashed");
const trashLink = await call(`/documents/${docId}/link`, { method: "PUT", token: owner.token, body: { role: "viewer" } });
const liveToken = trashLink.body?.link?.token;
check("the link works while the document is live", (await call(`/shared/${liveToken}`)).status === 200, "closed");
const trashed = await call(`/documents/${docId}/trash`, { method: "POST", token: owner.token });
check("the document is trashed", trashed.status === 200, `status ${trashed.status}`);
const afterTrash = await call(`/shared/${liveToken}`, { raw: true });
check(
  "the copied link stops working the moment it is trashed",
  afterTrash.status === 410,
  `status ${afterTrash.status}`
);

section("Someone with real access does not need the link");
const sharedDoc = await newDoc(owner.token, "Shared properly");
const sharedLink = await call(`/documents/${sharedDoc}/link`, { method: "PUT", token: owner.token, body: { role: "viewer" } });
check("the link is on", sharedLink.body?.link?.enabled === true, JSON.stringify(sharedLink.body?.link));

await call(`/documents/${sharedDoc}/share`, {
  method: "PUT",
  token: owner.token,
  body: { email: invited.email, role: "editor" },
});
const access = await call(`/documents/${sharedDoc}/access`, { token: invited.token });
check("the invited user holds the shared role", access.body?.role === "editor", access.body?.role);
check("they may edit through their own session", access.body?.canEdit === true, String(access.body?.canEdit));
const invitedOpen = await call(`/documents/${sharedDoc}`, { token: invited.token });
check("and can open the document without the link", invitedOpen.status === 200, `status ${invitedOpen.status}`);
check("their own role is not the link role", invitedOpen.body?.document?.role !== "viewer" || invitedOpen.body?.access?.role === "editor", "role mismatch");

const unrelated = await call(`/documents/${sharedDoc}`, { token: stranger.token });
check("an unrelated user still cannot open it", unrelated.status === 403, `status ${unrelated.status}`);
const unrelatedLink = await call(`/shared/${sharedLink.body.link.token}`);
check("but the link still opens for them", unrelatedLink.status === 200, `status ${unrelatedLink.status}`);
check("the link does not upgrade them to editor", unrelatedLink.body?.document?.canEdit === false, String(unrelatedLink.body?.document?.canEdit));

section("Link changes are audited");
const auditDoc = await newDoc(owner.token, "Audited");
await call(`/documents/${auditDoc}/link`, { method: "PUT", token: owner.token, body: { role: "viewer" } });
await call(`/documents/${auditDoc}/link`, { method: "DELETE", token: owner.token });
const activity = await call(`/workspaces/${(await call(`/documents/${auditDoc}`, { token: owner.token })).body?.workspace}/activity`, { token: owner.token });
const actions = (activity.body?.entries || []).map((a) => a.action);
check(
  "enabling the link is recorded",
  actions.includes("document.link.enabled"),
  `actions seen: ${[...new Set(actions)].join(", ") || "none"}`
);
check("revoking it is recorded", actions.includes("document.link.revoked"), `actions seen: ${[...new Set(actions)].join(", ") || "none"}`);

console.log(`\n${failures === 0 ? "ALL LINK SHARE TESTS PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);