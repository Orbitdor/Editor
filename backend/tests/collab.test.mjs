/**
 * Sprint 2 collaboration test: comments, mentions, sharing and permissions.
 *
 * Runs over HTTP against a live server, so it covers routing, validation, the
 * services and the database. It registers its own throwaway users with a
 * timestamp, so runs never collide and never touch real data.
 *
 * Usage (from backend/):
 *   PORT=5051 node index.js &
 *   API=http://localhost:5051/api/v1 node tests/collab.test.mjs
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

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    // Bounded so a request that never answers fails here instead of stalling the suite.
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

async function register(name, email) {
  const res = await call("/auth/register", {
    method: "POST",
    body: { name, email, password: "password123" },
  });
  if (res.status !== 201 && res.status !== 200) {
    // Already registered: log in instead.
    const login = await call("/auth/login", { method: "POST", body: { email, password: "password123" } });
    if (login.status !== 200) throw new Error(`cannot register/login ${email}: ${JSON.stringify(login)}`);
    return login.body;
  }
  return res.body;
}

const stamp = Date.now();
const ownerEmail = `sprint2owner${stamp}@example.com`;
const editorEmail = `sprint2editor${stamp}@example.com`;
const viewerEmail = `sprint2viewer${stamp}@example.com`;
const strangerEmail = `sprint2stranger${stamp}@example.com`;

console.log("\n== Setup ==");
const owner = await register("Owner Test", ownerEmail);
const editorUser = await register("Editor Test", editorEmail);
const viewerUser = await register("Viewer Test", viewerEmail);
const stranger = await register("Stranger Test", strangerEmail);
ok("4 users ready", `${ownerEmail}, ${editorEmail}, ${viewerEmail}, ${strangerEmail}`);

// A commenter is the middle role: reads and replies, but cannot edit content.
const commenterEmail = `sprint2commenter${stamp}@example.com`;
const commenterUser = await register("Commenter Test", commenterEmail);
ok("commenter account ready", commenterEmail);

const created = await call("/documents", {
  method: "POST",
  token: owner.token,
  body: { title: "Sprint 2 Collaboration Test" },
});
check("owner creates document", created.status === 201, `status ${created.status}`);
const docId = created.body._id;

console.log("\n== Access before sharing ==");
const strangerGet = await call(`/documents/${docId}`, { token: stranger.token });
check("stranger is denied", strangerGet.status === 403, `status ${strangerGet.status}`);

const strangerComments = await call(`/documents/${docId}/comments`, { token: stranger.token });
check("stranger cannot read comments", strangerComments.status === 403, `status ${strangerComments.status}`);

const strangerPost = await call(`/documents/${docId}/comments`, {
  method: "POST",
  token: stranger.token,
  body: { body: "should not be allowed" },
});
check("stranger cannot comment", strangerPost.status === 403, `status ${strangerPost.status}`);

const strangerStar = await call(`/documents/${docId}/star`, {
  method: "PATCH",
  token: stranger.token,
  body: { starred: true },
});
check("stranger cannot star", strangerStar.status === 403, `status ${strangerStar.status}`);

console.log("\n== Sharing ==");
const shareEditor = await call(`/documents/${docId}/share`, {
  method: "PUT",
  token: owner.token,
  body: { email: editorEmail, role: "editor" },
});
check("owner shares as editor", shareEditor.status === 200, JSON.stringify(shareEditor.body?.error || shareEditor.body?.length));

const shareViewer = await call(`/documents/${docId}/share`, {
  method: "PUT",
  token: owner.token,
  body: { email: viewerEmail, role: "viewer" },
});
check("owner shares as viewer", shareViewer.status === 200, JSON.stringify(shareViewer.body?.error || ""));

const editorShareAttempt = await call(`/documents/${docId}/share`, {
  method: "PUT",
  token: editorUser.token,
  body: { email: strangerEmail, role: "editor" },
});
check("non-owner cannot share", editorShareAttempt.status === 403, `status ${editorShareAttempt.status}`);

// A shared user should be able to see who else is in, without edit controls.
const editorView = await call(`/documents/${docId}/share`, { token: editorUser.token });
check(
  "non-owner sees the access list read-only",
  editorView.status === 200 && editorView.body?.shares?.length >= 1 && editorView.body?.myRole === "editor",
  `${editorView.body?.shares?.length} shares, role ${editorView.body?.myRole}`
);

const strangerView = await call(`/documents/${docId}/share`, { token: stranger.token });
check("stranger cannot see the access list", strangerView.status === 403, `status ${strangerView.status}`);

const shareState = await call(`/documents/${docId}/share`, { token: owner.token });
check("owner sees 2 shares", shareState.body?.shares?.length === 2, `count ${shareState.body?.shares?.length}`);
check(
  "owner role reported",
  shareState.body?.myRole === "owner",
  `myRole ${shareState.body?.myRole}`
);

console.log("\n== Access after sharing ==");
const editorAccess = await call(`/documents/${docId}/access`, { token: editorUser.token });
check(
  "editor capabilities",
  editorAccess.body?.canEdit === true && editorAccess.body?.canShare === false,
  JSON.stringify(editorAccess.body)
);

const viewerAccess = await call(`/documents/${docId}/access`, { token: viewerUser.token });
check(
  "viewer capabilities",
  viewerAccess.body?.canEdit === false && viewerAccess.body?.canComment === false,
  JSON.stringify(viewerAccess.body)
);

const editorGet = await call(`/documents/${docId}`, { token: editorUser.token });
check("editor can read document", editorGet.status === 200, `status ${editorGet.status}`);
check(
  "document carries access block",
  editorGet.body?.access?.role === "editor",
  JSON.stringify(editorGet.body?.access)
);

const editorSave = await call(`/documents/${docId}`, {
  method: "PUT",
  token: editorUser.token,
  body: { content: "<p>Edited by shared editor</p>" },
});
check("editor can save content", editorSave.status === 200, `status ${editorSave.status}`);

const viewerSave = await call(`/documents/${docId}`, {
  method: "PUT",
  token: viewerUser.token,
  body: { content: "<p>Viewer should not write</p>" },
});
check("viewer cannot save content", viewerSave.status === 403, `status ${viewerSave.status}`);

const viewerVersions = await call(`/documents/${docId}/versions`, { token: viewerUser.token });
check("viewer can read versions", viewerVersions.status === 200, `status ${viewerVersions.status}`);

const viewerRestore = await call(`/documents/${docId}/versions/1/restore`, {
  method: "POST",
  token: viewerUser.token,
});
check("viewer cannot restore version", viewerRestore.status === 403, `status ${viewerRestore.status}`);

console.log("\n== Shared-with-me ==");
const sharedWithMe = await call("/shared", { token: editorUser.token });
check(
  "editor sees doc in shared list",
  Array.isArray(sharedWithMe.body) && sharedWithMe.body.some((d) => d.document.id === docId),
  `${sharedWithMe.body?.length} entries`
);

const sharedWithStranger = await call("/shared", { token: stranger.token });
check(
  "stranger sees nothing",
  Array.isArray(sharedWithStranger.body) && sharedWithStranger.body.length === 0,
  `${sharedWithStranger.body?.length} entries`
);

console.log("\n== Mention search ==");
// Query the per-run token so earlier test users cannot crowd out the limit.
const mentionSearch = await call(`/notifications/mention-search?q=sprint2editor${stamp}`, {
  token: owner.token,
});
check(
  "mention search finds editor",
  mentionSearch.status === 200 && mentionSearch.body?.some((u) => u.email === editorEmail),
  `${mentionSearch.body?.length} results`
);
const selfExcluded = mentionSearch.body?.every((u) => u.email !== ownerEmail);
check("mention search excludes self", selfExcluded === true, "owner not in own results");

const strangerSearch = await call(`/notifications/mention-search?q=sprint2stranger${stamp}`, {
  token: owner.token,
});
check(
  "mention search finds any user, not just collaborators",
  strangerSearch.body?.some((u) => u.email === strangerEmail),
  `${strangerSearch.body?.length} results`
);

console.log("\n== Comments ==");
const emptyComments = await call(`/documents/${docId}/comments`, { token: owner.token });
check("owner lists comments (empty)", Array.isArray(emptyComments.body) && emptyComments.body.length === 0, `${emptyComments.body?.length}`);

const newComment = await call(`/documents/${docId}/comments`, {
  method: "POST",
  token: owner.token,
  body: {
    body: `Please review this @[Editor Test](${editorUser.user.id})`,
    quotedText: "Edited by shared editor",
    from: 1,
    to: 10,
  },
});
check("owner creates comment", newComment.status === 201, `status ${newComment.status}`);
const commentId = newComment.body?.id;
check(
  "mention resolved to a real user",
  newComment.body?.mentions?.[0]?.email === editorEmail,
  JSON.stringify(newComment.body?.mentions)
);

const reply = await call(`/documents/${docId}/comments/${commentId}/replies`, {
  method: "POST",
  token: editorUser.token,
  body: { body: "Thanks, looks good to me." },
});
check("editor replies", reply.status === 201, `status ${reply.status}`);

const nestedReply = await call(`/documents/${docId}/comments/${reply.body?.id}/replies`, {
  method: "POST",
  token: owner.token,
  body: { body: "Replying to a reply stays at depth 1." },
});
check(
  "reply depth capped at 1",
  nestedReply.body?.parentId === commentId,
  `parentId ${nestedReply.body?.parentId}`
);

const threads = await call(`/documents/${docId}/comments`, { token: editorUser.token });
check("thread list has 1 root", threads.body?.length === 1, `${threads.body?.length} roots`);
check("thread has 2 replies", threads.body?.[0]?.replies?.length === 2, `${threads.body?.[0]?.replies?.length} replies`);
check(
  "author display name resolved",
  threads.body?.[0]?.author?.name === "Owner Test",
  threads.body?.[0]?.author?.name
);
check(
  "quoted anchor preserved",
  threads.body?.[0]?.quotedText === "Edited by shared editor",
  threads.body?.[0]?.quotedText
);

const viewerComments = await call(`/documents/${docId}/comments`, { token: viewerUser.token });
check("viewer can read comments", viewerComments.status === 200, `status ${viewerComments.status}`);

const viewerCreate = await call(`/documents/${docId}/comments`, {
  method: "POST",
  token: viewerUser.token,
  body: { body: "viewers may not comment" },
});
check("viewer cannot create comments", viewerCreate.status === 403, `status ${viewerCreate.status}`);

console.log("\n== Commenter role ==");
const shareCommenter = await call(`/documents/${docId}/share`, {
  method: "PUT",
  token: owner.token,
  body: { email: commenterEmail, role: "commenter" },
});
check("owner shares as commenter", shareCommenter.status === 200, `status ${shareCommenter.status}`);

const commenterAccess = await call(`/documents/${docId}/access`, { token: commenterUser.token });
check(
  "commenter capabilities",
  commenterAccess.body?.canComment === true && commenterAccess.body?.canEdit === false,
  JSON.stringify(commenterAccess.body)
);

const commenterSave = await call(`/documents/${docId}`, {
  method: "PUT",
  token: commenterUser.token,
  body: { content: "<p>commenter should not write</p>" },
});
check("commenter cannot save content", commenterSave.status === 403, `status ${commenterSave.status}`);

const commenterPost = await call(`/documents/${docId}/comments`, {
  method: "POST",
  token: commenterUser.token,
  body: { body: "Commenting from the commenter role." },
});
check("commenter can comment", commenterPost.status === 201, `status ${commenterPost.status}`);

const strangerReply = await call(`/documents/${docId}/comments/${commentId}/replies`, {
  method: "POST",
  token: stranger.token,
  body: { body: "let me in" },
});
check("stranger cannot reply", strangerReply.status === 403, `status ${strangerReply.status}`);

const edit = await call(`/documents/${docId}/comments/${commentId}`, {
  method: "PATCH",
  token: owner.token,
  body: { body: "Please review this, thanks." },
});
check("author edits own comment", edit.status === 200 && Boolean(edit.body?.editedAt), `status ${edit.status}`);

const strangerEdit = await call(`/documents/${docId}/comments/${commentId}`, {
  method: "PATCH",
  token: editorUser.token,
  body: { body: "hijack" },
});
check("non-author cannot edit", strangerEdit.status === 403, `status ${strangerEdit.status}`);

const resolve = await call(`/documents/${docId}/comments/${commentId}/resolve`, {
  method: "POST",
  token: owner.token,
  body: { resolved: true },
});
check("thread resolves", resolve.status === 200 && resolve.body?.resolved === true, `status ${resolve.status}`);

const resolveReply = await call(`/documents/${docId}/comments/${reply.body?.id}/resolve`, {
  method: "POST",
  token: owner.token,
  body: { resolved: true },
});
check("cannot resolve a reply", resolveReply.status === 400, `status ${resolveReply.status}`);

const reopen = await call(`/documents/${docId}/comments/${commentId}/resolve`, {
  method: "POST",
  token: owner.token,
  body: { resolved: false },
});
check("thread reopens", reopen.status === 200 && reopen.body?.resolved === false, `status ${reopen.status}`);

console.log("\n== Notifications ==");
const editorNotifs = await call("/notifications", { token: editorUser.token });
check("editor has notifications", editorNotifs.body?.items?.length >= 1, `${editorNotifs.body?.items?.length} items`);
check("editor has unread", editorNotifs.body?.unread >= 1, `unread ${editorNotifs.body?.unread}`);
check(
  "share notification delivered",
  editorNotifs.body?.items?.some((n) => n.type === "share"),
  editorNotifs.body?.items?.map((n) => n.type).join(",")
);
check(
  "mention notification delivered",
  editorNotifs.body?.items?.some((n) => n.type === "mention"),
  editorNotifs.body?.items?.map((n) => n.type).join(",")
);

await call("/notifications/read", { method: "POST", token: editorUser.token, body: {} });
const afterRead = await call("/notifications", { token: editorUser.token });
check("mark-all-read works", afterRead.body?.unread === 0, `unread ${afterRead.body?.unread}`);

const ownerNotifs = await call("/notifications", { token: owner.token });
check(
  "owner notified about editor reply",
  ownerNotifs.body?.items?.some((n) => n.type === "comment"),
  ownerNotifs.body?.items?.map((n) => n.type).join(",")
);

console.log("\n== Role change and revoke ==");
const downgrade = await call(`/documents/${docId}/share`, {
  method: "PUT",
  token: owner.token,
  body: { email: editorEmail, role: "viewer" },
});
check("role downgraded to viewer", downgrade.status === 200, `status ${downgrade.status}`);

const editorSaveAfter = await call(`/documents/${docId}`, {
  method: "PUT",
  token: editorUser.token,
  body: { content: "<p>should fail</p>" },
});
check("downgraded editor loses write access", editorSaveAfter.status === 403, `status ${editorSaveAfter.status}`);

const revoke = await call(`/documents/${docId}/share/${editorUser.user.id}`, {
  method: "DELETE",
  token: owner.token,
});
check("access revoked", revoke.status === 200, `status ${revoke.status}`);

const editorAfterRevoke = await call(`/documents/${docId}`, { token: editorUser.token });
check("revoked user is blocked", editorAfterRevoke.status === 403, `status ${editorAfterRevoke.status}`);

const ownerRevokeSelf = await call(`/documents/${docId}/share/${owner.user.id}`, {
  method: "DELETE",
  token: owner.token,
});
check("owner cannot revoke self", ownerRevokeSelf.status === 400, `status ${ownerRevokeSelf.status}`);

console.log("\n== Comment deletion ==");
const del = await call(`/documents/${docId}/comments/${commentId}`, {
  method: "DELETE",
  token: owner.token,
});
check("thread deleted with replies", del.status === 200, `status ${del.status}`);

const afterDelete = await call(`/documents/${docId}/comments`, { token: owner.token });
const remainingIds = afterDelete.body?.map((t) => t.id) || [];
check("deleted thread is gone", !remainingIds.includes(commentId), remainingIds.join(",") || "none");
check(
  "its replies went with it",
  !afterDelete.body?.some((t) => t.replies?.some((r) => r.id === reply.body?.id)),
  "orphan reply found"
);
const leftover = afterDelete.body?.length || 0;
check(
  "only the commenter's own thread remains",
  leftover === 1 && afterDelete.body?.[0]?.author?.name === "Commenter Test",
  `${leftover} threads`
);

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
console.log(`cleanup: trash the test document ${docId} from the dashboard if needed.`);
process.exit(failures === 0 ? 0 : 1);
