/**
 * Folders (master plan section 11, and the `folderId` of section 34).
 *
 * The interesting behaviour is not "can create a folder", it is:
 *   - the permission ladder matches the rest of the app (editor to organise,
 *     admin to destroy);
 *   - a folder cannot be moved into its own subtree;
 *   - one workspace can never file another workspace's document;
 *   - trashing a folder keeps the documents.
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
  // Every call is bounded: a request that never answers should surface as a
  // failure here instead of stalling the whole suite.
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

async function makeUser(tag) {
  const stamp = `${tag}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
  const email = `${stamp}@test.local`;
  const res = await call("/auth/register", {
    method: "POST",
    body: { name: tag, email, password: "Str0ngPass!" },
  });
  if (res.status !== 201) throw new Error(`could not create ${tag}: ${JSON.stringify(res.body)}`);
  // The User model lowercases addresses, so the roster and the invite both see
  // the folded form. Comparing against the mixed-case original would never match.
  return {
    name: tag,
    email: res.body.user.email.toLowerCase(),
    password: "Str0ngPass!",
    token: res.body.token,
    id: res.body.user.id,
  };
}

section("A personal workspace can be organised");
const owner = await makeUser("FolderOwner");
const outsiders = await makeUser("FolderOutsider");

const work = await call("/folders", { method: "POST", token: owner.token, body: { name: "Work" } });
check("a folder can be created", work.status === 201, `status ${work.status}`);
const workId = work.body?.folder?._id;
check("the folder carries a workspace", !!work.body?.folder?.workspace, JSON.stringify(work.body?.folder));

const projects = await call("/folders", {
  method: "POST",
  token: owner.token,
  body: { name: "Projects", parent: workId },
});
check("a folder can nest inside another", projects.status === 201, `status ${projects.status}`);
const projectsId = projects.body?.folder?._id;

const tree = await call("/folders", { token: owner.token });
check(
  "the tree nests the child under the parent",
  tree.body.folders?.length === 1 && tree.body.folders[0].children?.[0]?._id === projectsId,
  JSON.stringify(tree.body?.folders?.map((f) => [f.name, f.children?.length]))
);

const dup = await call("/folders", { method: "POST", token: owner.token, body: { name: "work" } });
check("a duplicate name is rejected, even case-insensitively", dup.status === 409, `status ${dup.status}`);

const blank = await call("/folders", { method: "POST", token: owner.token, body: { name: "   " } });
check("a blank name is rejected", blank.status === 400, `status ${blank.status}`);

section("Documents can be filed, and the folder list filters");
const filed = await call("/documents", {
  method: "POST",
  token: owner.token,
  body: { title: "Property Proposal", folderId: workId },
});
check("a document can be created inside a folder", filed.status === 201, `status ${filed.status}`);
const filedId = filed.body?._id;
check("the document records its folder", filed.body?.folder === workId, filed.body?.folder);

const loose = await call("/documents", { method: "POST", token: owner.token, body: { title: "Loose Note" } });
const looseId = loose.body?._id;

const inFolder = await call(`/documents?folderId=${workId}`, { token: owner.token });
check(
  "the folder lists only its own document",
  inFolder.body?.length === 1 && inFolder.body[0]._id === filedId,
  `${inFolder.body?.length} docs`
);

const unfiled = await call("/documents?unfiled=true", { token: owner.token });
check(
  "unfiled lists the rest",
  unfiled.body?.length === 1 && unfiled.body[0]._id === looseId,
  `${unfiled.body?.length} docs`
);

const contents = await call(`/folders/${workId}/contents`, { token: owner.token });
check("folder contents can be read", contents.status === 200 && contents.body.documents.length === 1, `status ${contents.status}`);

section("Moving a document re-files it");
const moved = await call(`/folders/documents/${looseId}`, {
  method: "PUT",
  token: owner.token,
  body: { folderId: projectsId },
});
check("a document can move between folders", moved.status === 200, `status ${moved.status}`);
const projectsNow = await call(`/documents?folderId=${projectsId}`, { token: owner.token });
check("it shows under the new folder", projectsNow.body?.some((d) => d._id === looseId), `${projectsNow.body?.length} docs`);
const workNow = await call(`/documents?folderId=${workId}`, { token: owner.token });
check("and no longer under the old one", !workNow.body?.some((d) => d._id === looseId), `${workNow.body?.length} docs`);

const unfiledOut = await call("/documents?unfiled=true", { token: owner.token });
check("unfiled no longer lists it", !unfiledOut.body?.some((d) => d._id === looseId), `${unfiledOut.body?.length} docs`);

const putElsewhere = await call(`/folders/documents/${filedId}`, {
  method: "PUT",
  token: owner.token,
  body: { folderId: null },
});
check("a document can be unfiled", putElsewhere.status === 200, `status ${putElsewhere.status}`);
check("its folder is now null", putElsewhere.body?.document?.folder === null, JSON.stringify(putElsewhere.body?.document));
await call(`/folders/documents/${filedId}`, { method: "PUT", token: owner.token, body: { folderId: workId } });

section("A folder cannot swallow itself");
const selfParent = await call(`/folders/${workId}`, {
  method: "PATCH",
  token: owner.token,
  body: { parent: workId },
});
check("a folder cannot parent itself", selfParent.status === 400, `status ${selfParent.status}`);

const grandchild = await call("/folders", {
  method: "POST",
  token: owner.token,
  body: { name: "Contracts", parent: projectsId },
});
const grandchildId = grandchild.body?.folder?._id;
const cycle = await call(`/folders/${workId}`, {
  method: "PATCH",
  token: owner.token,
  body: { parent: grandchildId },
});
check("a folder cannot move into its own descendant", cycle.status === 400, `status ${cycle.status}`);

const reparent = await call(`/folders/${grandchildId}`, {
  method: "PATCH",
  token: owner.token,
  body: { parent: null },
});
check("a folder can move to the top level", reparent.status === 200, `status ${reparent.status}`);

section("Trashing a folder keeps the documents");
const trashWork = await call(`/folders/${workId}`, { method: "DELETE", token: owner.token });
check("a folder can be trashed", trashWork.status === 200, `status ${trashWork.status}`);
check("it is marked trashed", !!trashWork.body?.folder?.trashedAt, JSON.stringify(trashWork.body?.folder));

const childAfter = await call("/folders", { token: owner.token });
check(
  "child folders are trashed with their parent",
  !childAfter.body.folders?.some((f) => f._id === projectsId),
  JSON.stringify(childAfter.body?.folders?.map((f) => f.name))
);

const docsAfterTrash = await call("/documents", { token: owner.token });
check(
  "the documents survive",
  docsAfterTrash.body?.some((d) => d._id === filedId),
  `${docsAfterTrash.body?.length} docs`
);
const filedFolderAfter = docsAfterTrash.body?.find((d) => d._id === filedId);
check("and are unfiled", filedFolderAfter?.folder === null, `${filedFolderAfter?.folder}`);

const trashedList = await call("/folders/trash", { token: owner.token });
check("trashed folders are listed separately", trashedList.body?.folders?.some((f) => f._id === workId), `${trashedList.body?.folders?.length} trashed`);

const restore = await call(`/folders/${workId}/restore`, { method: "POST", token: owner.token });
check("a folder can be restored", restore.status === 200 && !restore.body?.folder?.trashedAt, `status ${restore.status}`);

section("One workspace never sees another");
const otherUser = await makeUser("FolderTeammate");
const team = await call("/workspaces", {
  method: "POST",
  token: owner.token,
  body: { name: "Acme Reports" },
});
// The workspace create endpoint answers with the workspace itself, not a wrapper.
const teamId = team.body?.id;
check("a team can be created", team.status === 201, `status ${team.status}`);
const invite = await call(`/workspaces/${teamId}/members`, {
  method: "POST",
  token: owner.token,
  body: { email: otherUser.email, role: "editor" },
});
check("an editor can be invited", invite.status === 201 || invite.status === 200, `status ${invite.status}`);

const teamFolder = await call("/folders", {
  method: "POST",
  token: owner.token,
  body: { name: "Q1", workspaceId: teamId },
});
check("a team folder can be created", teamFolder.status === 201, `status ${teamFolder.status}`);
const teamFolderId = teamFolder.body?.folder?._id;

const teamLists = await call(`/folders?workspaceId=${teamId}`, { token: owner.token });
check("the team sees only its own folders", teamLists.body?.folders?.length === 1 && teamLists.body.folders[0]._id === teamFolderId, `${teamLists.body?.folders?.length} folders`);

const personalList = await call("/folders", { token: owner.token });
check("personal folders are a separate list", !personalList.body?.folders?.some((f) => f._id === teamFolderId), `${personalList.body?.folders?.length} folders`);

const crossCreate = await call("/documents", {
  method: "POST",
  token: owner.token,
  body: { title: "Wrong Home", folderId: teamFolderId },
});
check("a personal document cannot be filed into a team folder", crossCreate.status === 400, `status ${crossCreate.status}`);

const crossParent = await call("/folders", {
  method: "POST",
  token: owner.token,
  body: { name: "Nested Wrong", parent: teamFolderId },
});
check("a personal folder cannot nest under a team folder", crossParent.status === 400, `status ${crossParent.status}`);

const foreignView = await call(`/folders?workspaceId=${teamId}`, { token: outsiders.token });
check("an outsider cannot list a team's folders", foreignView.status === 404, `status ${foreignView.status}`);
const foreignContents = await call(`/folders/${teamFolderId}/contents`, { token: outsiders.token });
check("an outsider cannot read folder contents", foreignContents.status === 404, `status ${foreignContents.status}`);
const foreignFolder = await call(`/folders/${teamFolderId}`, { method: "DELETE", token: outsiders.token });
check("an outsider cannot trash a folder", foreignFolder.status === 404, `status ${foreignFolder.status}`);

section("Permissions follow the workspace ladder");
// The invited editor is demoted to viewer, which is the role that may look but
// not reorganise. The member id comes from the roster, not from the user id.
const roster = await call(`/workspaces/${teamId}/members`, { token: owner.token });
const editorRow = roster.body?.members?.find((m) => m.email === otherUser.email);
const demote = await call(`/workspaces/${teamId}/members/${editorRow.id}`, {
  method: "PATCH",
  token: owner.token,
  body: { role: "viewer" },
});
check("the editor can be demoted to viewer", demote.status === 200, `status ${demote.status}`);

const viewer = await call("/auth/login", {
  method: "POST",
  body: { email: otherUser.email, password: otherUser.password },
});
const viewerToken = viewer.body?.token;
const viewerList = await call(`/folders?workspaceId=${teamId}`, { token: viewerToken });
check("a viewer can list folders", viewerList.status === 200, `status ${viewerList.status}`);
const viewerCreate = await call("/folders", {
  method: "POST",
  token: viewerToken,
  body: { name: "Viewer Folder", workspaceId: teamId },
});
check("a viewer cannot create a folder", viewerCreate.status === 403, `status ${viewerCreate.status}`);
const viewerTrash = await call(`/folders/${teamFolderId}`, { method: "DELETE", token: viewerToken });
check("a viewer cannot trash a folder", viewerTrash.status === 403, `status ${viewerTrash.status}`);
const viewerPermanent = await call(`/folders/${teamFolderId}/permanent`, { method: "DELETE", token: viewerToken });
check("a viewer cannot permanently delete a folder", viewerPermanent.status === 403, `status ${viewerPermanent.status}`);

const permanent = await call(`/folders/${teamFolderId}/permanent`, { method: "DELETE", token: owner.token });
check("the owner can permanently delete a folder", permanent.status === 200, `status ${permanent.status}`);
const goneList = await call(`/folders?workspaceId=${teamId}`, { token: owner.token });
check("and it is gone", !goneList.body?.folders?.some((f) => f._id === teamFolderId), `${goneList.body?.folders?.length} folders`);

section("The audit log records folder activity");
const activity = await call(`/workspaces/${teamId}/activity`, { token: owner.token });
const actions = (activity.body?.entries || []).map((a) => a.action);
check("folder creation is audited", actions.includes("folder.created"), actions.join(","));
check("folder deletion is audited", actions.includes("folder.deleted"), actions.join(","));
const folderCreate = (await call("/folders", { method: "POST", token: owner.token, body: { name: "Audited" } })).body.folder;
await call(`/folders/documents/${looseId}`, { method: "PUT", token: owner.token, body: { folderId: folderCreate._id } });
const personalActivity = await call("/workspaces", { token: owner.token });
// The workspace list serialises each row as a flat object with `id`, not `_id`.
const personalWsId = personalActivity.body.workspaces?.find((w) => w.isPersonal)?.id;
const movedAudit = await call(`/workspaces/${personalWsId}/activity`, { token: owner.token });
check(
  "document moves are audited",
  (movedAudit.body?.entries || []).some((a) => a.action === "document.moved"),
  (movedAudit.body?.entries || []).map((a) => a.action).join(",")
);

console.log(failures ? `\n${failures} FOLDER CHECK(S) FAILED` : "\nALL FOLDER CHECKS PASSED");
process.exit(failures ? 1 : 0);