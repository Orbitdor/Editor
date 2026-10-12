/**
 * Sprint 6 test: workspaces, membership, roles, plan limits and the audit log
 * (master plan sections 36, 46 and 49).
 *
 * The interesting part is the permission boundary, so most checks ask "can the
 * wrong person do this?" rather than "does the happy path work".
 *
 * Usage (from backend/):
 *   TEST_FILTER=workspace npm test
 *   BILLING_ENABLED=true TEST_FILTER=workspace npm test   (exercises plan changes)
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

const stamp = Date.now();

/** A fresh account. Names double as the email prefix, which is how cleanup finds them. */
async function user(name) {
  const email = `${name}${stamp}@example.com`;
  const body = { name, email, password: "password123" };
  const res = await call("/auth/register", { method: "POST", body });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`cannot register ${name}: ${JSON.stringify(res)}`);
  }
  return { ...res.body, email };
}

const owner = await user("wsowner");
const admin = await user("wsadmin");
const editor = await user("wseditor");
const member = await user("wsmember");
const viewer = await user("wsviewer");
const outsider = await user("wsoutsider");

console.log("\n== Personal workspace ==");
const mine = await call("/workspaces", { token: owner.token });
check("workspaces list returns 200", mine.status === 200, `status ${mine.status}`);
const personal = mine.body?.workspaces?.find((w) => w.isPersonal);
check("a personal workspace is created automatically", Boolean(personal), `${mine.body?.workspaces?.length} workspaces`);
check("the personal workspace starts on the free plan", personal?.plan === "free", personal?.plan);
check("the caller is the owner of their personal space", personal?.myRole === "owner", personal?.myRole);
check("the personal workspace reports its limits", personal?.limits?.maxDocuments === 25, `${personal?.limits?.maxDocuments} documents`);

const twice = await call("/workspaces", { token: owner.token });
const personalAgain = twice.body?.workspaces?.find((w) => w.isPersonal);
check("asking twice does not duplicate it", personalAgain?.id === personal?.id, `${personalAgain?.id} vs ${personal?.id}`);
check("only one workspace so far", twice.body?.workspaces?.length === 1, `${twice.body?.workspaces?.length}`);

const anon = await call("/workspaces");
check("the list requires auth", anon.status === 401, `status ${anon.status}`);

console.log("\n== Documents land in a workspace ==");
const personalDoc = await call("/documents", { method: "POST", token: owner.token, body: { title: "Personal doc" } });
check("a document can still be created", personalDoc.status === 201, `status ${personalDoc.status}`);

console.log("\n== Teams ==");
const badName = await call("/workspaces", { method: "POST", token: owner.token, body: { name: "" } });
check("a team needs a name", badName.status === 400, `status ${badName.status}`);

const team = await call("/workspaces", { method: "POST", token: owner.token, body: { name: "Acme Design" } });
check("a team can be created", team.status === 201, `status ${team.status} ${JSON.stringify(team.body?.error || "")}`);
const teamId = team.body?.id;
check("the team is not personal", team.body?.isPersonal === false, String(team.body?.isPersonal));
check("the team gets a slug", typeof team.body?.slug === "string" && team.body.slug.startsWith("acme-design"), team.body?.slug);
check("the team reports its limits", team.body?.limits?.maxDocuments > 0, `${team.body?.limits?.maxDocuments} documents`);

// Free includes two workspaces and the personal one already uses one of them.
const tooManyTeams = await call("/workspaces", { method: "POST", token: owner.token, body: { name: "Second Team" } });
check("the free workspace ceiling is enforced", tooManyTeams.status === 409, `status ${tooManyTeams.status}`);
check("the refusal names the workspace limit", /workspace/i.test(tooManyTeams.body?.error || ""), tooManyTeams.body?.error);

console.log("\n== Seat limits (a throwaway team) ==");
const seater = await user("wsseater");
const seatTeam = await call("/workspaces", { method: "POST", token: seater.token, body: { name: "Seat Test" } });
const seatTeamId = seatTeam.body?.id;
const seatA = await call(`/workspaces/${seatTeamId}/members`, { method: "POST", token: seater.token, body: { email: admin.email } });
const seatB = await call(`/workspaces/${seatTeamId}/members`, { method: "POST", token: seater.token, body: { email: viewer.email } });
check("the free seats fill up", seatA.status === 201 && seatB.status === 201, `${seatA.status}/${seatB.status}`);
const seatC = await call(`/workspaces/${seatTeamId}/members`, { method: "POST", token: seater.token, body: { email: outsider.email } });
check("the next seat is refused", seatC.status === 409, `status ${seatC.status}`);
check("the refusal explains the limit", /limit/i.test(seatC.body?.error || ""), seatC.body?.error);

console.log("\n== Membership ==");
const inviteAnon = await call(`/workspaces/${teamId}/members`, { method: "POST", token: outsider.token, body: { email: admin.email } });
check("a stranger cannot invite", inviteAnon.status === 404, `status ${inviteAnon.status}`);

const inviteBad = await call(`/workspaces/${teamId}/members`, { method: "POST", token: owner.token, body: { email: "not-an-email" } });
check("a bad email is rejected", inviteBad.status === 400, `status ${inviteBad.status}`);

const inviteOwnerRole = await call(`/workspaces/${teamId}/members`, { method: "POST", token: owner.token, body: { email: admin.email, role: "owner" } });
check("ownership cannot be granted by invite", inviteOwnerRole.status === 400, `status ${inviteOwnerRole.status}`);

const inviteSelf = await call(`/workspaces/${teamId}/members`, { method: "POST", token: owner.token, body: { email: owner.email } });
check("the owner cannot invite themselves", inviteSelf.status === 409, `status ${inviteSelf.status}`);

const inviteTwiceUser = await call(`/workspaces/${teamId}/members`, { method: "POST", token: owner.token, body: { email: editor.email, role: "editor" } });
check("an existing account joins as active", inviteTwiceUser.status === 201, `status ${inviteTwiceUser.status}`);
check("the invite reports the new status", inviteTwiceUser.body?.status === "active", inviteTwiceUser.body?.status);

const inviteAgain = await call(`/workspaces/${teamId}/members`, { method: "POST", token: owner.token, body: { email: editor.email } });
check("the same person cannot join twice", inviteAgain.status === 409, `status ${inviteAgain.status}`);

const inviteSecond = await call(`/workspaces/${teamId}/members`, { method: "POST", token: owner.token, body: { email: member.email } });
check("the second member joins", inviteSecond.status === 201, `status ${inviteSecond.status}`);

const fullTeam = await call(`/workspaces/${teamId}/members`, { method: "POST", token: owner.token, body: { email: viewer.email } });
check("the team is now at its free seat limit", fullTeam.status === 409, `status ${fullTeam.status}`);

console.log("\n== Role enforcement ==");
const editorInvites = await call(`/workspaces/${teamId}/members`, { method: "POST", token: editor.token, body: { email: viewer.email } });
check("an editor cannot add members", editorInvites.status === 403, `status ${editorInvites.status}`);

const editorRenames = await call(`/workspaces/${teamId}`, { method: "PATCH", token: editor.token, body: { name: "Renamed by editor" } });
check("an editor cannot rename the workspace", editorRenames.status === 403, `status ${editorRenames.status}`);

const editorReads = await call(`/workspaces/${teamId}`, { token: editor.token });
check("an editor can read the workspace", editorReads.status === 200, `status ${editorReads.status}`);
check("the reader learns their role", editorReads.body?.myRole === "editor", editorReads.body?.myRole);

const rename = await call(`/workspaces/${teamId}`, { method: "PATCH", token: owner.token, body: { name: "Acme Design Studio" } });
check("the owner can rename it", rename.status === 200, `status ${rename.status}`);
check("the new name is kept", rename.body?.name === "Acme Design Studio", rename.body?.name);

console.log("\n== Documents follow workspace access ==");
const teamDoc = await call("/documents", {
  method: "POST",
  token: owner.token,
  body: { title: "Shared via workspace", workspaceId: teamId },
});
check("a team document can be created", teamDoc.status === 201, `status ${teamDoc.status} ${JSON.stringify(teamDoc.body?.error || "")}`);
const teamDocId = teamDoc.body?._id;

const memberReads = await call(`/documents/${teamDocId}`, { token: member.token });
check("a workspace member can read the team document", memberReads.status === 200, `status ${memberReads.status}`);

const editorReadsDoc = await call(`/documents/${teamDocId}`, { token: editor.token });
check("an editor can read it too", editorReadsDoc.status === 200, `status ${editorReadsDoc.status}`);

const outsiderReads = await call(`/documents/${teamDocId}`, { token: outsider.token });
check("an outsider cannot read a team document", outsiderReads.status === 403 || outsiderReads.status === 404, `status ${outsiderReads.status}`);

const outsiderWrites = await call(`/documents/${teamDocId}`, {
  method: "PATCH",
  token: outsider.token,
  body: { content: "hijacked" },
});
check("an outsider cannot edit it", outsiderWrites.status === 403 || outsiderWrites.status === 404, `status ${outsiderWrites.status}`);

const outsiderCreates = await call("/documents", {
  method: "POST",
  token: outsider.token,
  body: { title: "Not allowed", workspaceId: teamId },
});
check("an outsider cannot add documents to the team", outsiderCreates.status === 403 || outsiderCreates.status === 404, `status ${outsiderCreates.status}`);

const outsiderPersonal = await call("/documents", { method: "POST", token: outsider.token, body: { title: "Still mine" } });
check("an outsider can still create their own document", outsiderPersonal.status === 201, `status ${outsiderPersonal.status}`);

// A direct share reaches someone who is not in the workspace at all, which is the
// whole point of the two mechanisms coexisting.
const shared = await call(`/documents/${teamDocId}/share`, {
  method: "PUT",
  token: owner.token,
  body: { email: admin.email, role: "viewer" },
});
check("the owner can share a team document directly", shared.status === 200 || shared.status === 201, `status ${shared.status}`);
const adminReads = await call(`/documents/${teamDocId}`, { token: admin.token });
check("the person shared with can read it", adminReads.status === 200, `status ${adminReads.status}`);
const adminStillOutside = await call(`/workspaces/${teamId}`, { token: admin.token });
check("sharing a document does not join them to the workspace", adminStillOutside.status === 404, `status ${adminStillOutside.status}`);

console.log("\n== Plans ==");
// A plan change is only possible where billing is switched on. Without it the
// endpoint has to refuse, otherwise an owner grants themselves Pro for free.
const catalogue = await call("/workspaces/plans", { token: owner.token });
const billingOn = catalogue.body?.billingEnabled === true;
console.log(`  INFO  billing is ${billingOn ? "enabled" : "disabled"} on this deployment`);
check("the catalogue lists both plans", catalogue.body?.plans?.length === 2, `${catalogue.body?.plans?.length} plans`);

const badPlan = await call(`/workspaces/${teamId}/plan`, { method: "POST", token: owner.token, body: { plan: "platinum" } });
check("an unknown plan is rejected", badPlan.status === 400, `status ${badPlan.status}`);

const editorPlan = await call(`/workspaces/${teamId}/plan`, { method: "POST", token: editor.token, body: { plan: "pro" } });
check("an editor cannot change the plan", editorPlan.status === 403, `status ${editorPlan.status}`);

const upgrade = await call(`/workspaces/${teamId}/plan`, { method: "POST", token: owner.token, body: { plan: "pro" } });
if (billingOn) {
  check("the owner can move to pro", upgrade.status === 200, `status ${upgrade.status}`);
  check("the plan is now pro", upgrade.body?.plan === "pro", upgrade.body?.plan);
  check("the pro limits are applied", upgrade.body?.limits?.maxMembers === 50, `${upgrade.body?.limits?.maxMembers} seats`);
  check("pro raises the AI allowance", upgrade.body?.limits?.aiPerMonth === 2000, `${upgrade.body?.limits?.aiPerMonth} actions`);

  const seatViewer = await call(`/workspaces/${teamId}/members`, { method: "POST", token: owner.token, body: { email: viewer.email, role: "viewer" } });
  check("upgrading frees a seat", seatViewer.status === 201, `status ${seatViewer.status} ${JSON.stringify(seatViewer.body?.error || "")}`);

  const downgrade = await call(`/workspaces/${teamId}/plan`, { method: "POST", token: owner.token, body: { plan: "free" } });
  check("the plan can move back", downgrade.status === 200, `status ${downgrade.status}`);
  check("the plan is free again", downgrade.body?.plan === "free", downgrade.body?.plan);
} else {
  check("without billing the owner cannot self-upgrade", upgrade.status === 403, `status ${upgrade.status}`);
  const untouched = await call(`/workspaces/${teamId}`, { token: owner.token });
  check("the plan is unchanged after the refusal", untouched.body?.plan === "free", untouched.body?.plan);
}

console.log("\n== Changing roles ==");
const members = await call(`/workspaces/${teamId}/members`, { token: owner.token });
const memberRow = members.body?.members?.find((m) => m.email === member.email);
const ownerRow = members.body?.members?.find((m) => m.email === owner.email);
check("the member list shows the roster", members.body?.members?.length >= 3, `${members.body?.members?.length} members`);
check("the member list carries the role", memberRow?.role === "member", memberRow?.role);
check("the member list shows the status", memberRow?.status === "active", memberRow?.status);
check("the owner is listed as owner", ownerRow?.role === "owner", ownerRow?.role);

const promote = await call(`/workspaces/${teamId}/members/${memberRow.id}`, {
  method: "PATCH",
  token: owner.token,
  body: { role: "admin" },
});
check("a role can be changed", promote.status === 200, `status ${promote.status}`);
check("the new role is returned", promote.body?.role === "admin", promote.body?.role);

const badRole = await call(`/workspaces/${teamId}/members/${memberRow.id}`, {
  method: "PATCH",
  token: owner.token,
  body: { role: "superuser" },
});
check("an unknown role is rejected", badRole.status === 400, `status ${badRole.status}`);

const grantOwner = await call(`/workspaces/${teamId}/members/${memberRow.id}`, {
  method: "PATCH",
  token: owner.token,
  body: { role: "owner" },
});
check("nobody promotes themselves to owner", grantOwner.status === 400, `status ${grantOwner.status}`);

const demoteOwner = await call(`/workspaces/${teamId}/members/${ownerRow.id}`, {
  method: "PATCH",
  token: member.token,
  body: { role: "viewer" },
});
check("an admin cannot demote the owner", demoteOwner.status === 400, `status ${demoteOwner.status}`);

const adminLists = await call(`/workspaces/${teamId}/members`, { token: member.token });
check("the new admin can read the member list", adminLists.status === 200, `status ${adminLists.status}`);

const outsiderMembers = await call(`/workspaces/${teamId}/members`, { token: outsider.token });
check("an outsider cannot read the member list", outsiderMembers.status === 404, `status ${outsiderMembers.status}`);

console.log("\n== Audit log ==");
const logDenied = await call(`/workspaces/${teamId}/activity`, { token: outsider.token });
check("an outsider cannot read the log", logDenied.status === 404, `status ${logDenied.status}`);

const adminLog = await call(`/workspaces/${teamId}/activity`, { token: member.token });
check("an admin can read the log", adminLog.status === 200, `status ${adminLog.status}`);

const editorLogDenied = await call(`/workspaces/${teamId}/activity`, { token: editor.token });
check("an editor cannot read the log", editorLogDenied.status === 403, `status ${editorLogDenied.status}`);

const log = await call(`/workspaces/${teamId}/activity`, { token: owner.token });
check("the owner can read the log", log.status === 200, `status ${log.status}`);
check("the log has entries", log.body?.entries?.length > 0, `${log.body?.entries?.length} entries`);

const actions = (log.body?.entries || []).map((e) => e.action);
check("workspace creation is logged", actions.includes("workspace.created"), actions.join(","));
check("member invites are logged", actions.includes("member.invited"), true);
check("role changes are logged", actions.includes("member.role_changed"), true);
check("documents are logged", actions.includes("document.created"), true);
check("shares are logged", actions.includes("document.shared"), true);

const newest = log.body?.entries?.[0];
check("entries name an actor", Boolean(newest?.actorName || newest?.actor), newest?.actorName);
check("entries carry a timestamp", Boolean(newest?.createdAt), newest?.createdAt);
check("entries never carry a password", !JSON.stringify(log.body).includes("password"), "clean");

const filtered = await call(`/workspaces/${teamId}/activity?action=member.invited`, { token: owner.token });
check("the log can be filtered by action", filtered.body?.entries?.every((e) => e.action === "member.invited"), `${filtered.body?.entries?.length} entries`);

const badAction = await call(`/workspaces/${teamId}/activity?action=not.a.thing`, { token: owner.token });
check("an unknown filter is rejected", badAction.status === 400, `status ${badAction.status}`);

const limited = await call(`/workspaces/${teamId}/activity?limit=2`, { token: owner.token });
check("the log page size is honoured", limited.body?.entries?.length === 2, `${limited.body?.entries?.length} entries`);
check("a cursor is offered when more remain", Boolean(limited.body?.nextCursor), limited.body?.nextCursor);

const nextPage = await call(
  `/workspaces/${teamId}/activity?limit=2&before=${encodeURIComponent(limited.body.nextCursor)}`,
  { token: owner.token }
);
check("paging returns different entries", nextPage.body?.entries?.[0]?.id !== limited.body?.entries?.[0]?.id, nextPage.body?.entries?.[0]?.id);

const summary = await call(`/workspaces/${teamId}/activity/summary`, { token: owner.token });
check("the summary groups by action", summary.status === 200 && summary.body?.actions?.length > 0, `${summary.body?.actions?.length} actions`);

const personalLog = await call(`/workspaces/${personal.id}/activity`, { token: owner.token });
const personalActions = (personalLog.body?.entries || []).map((e) => e.action);
check("a personal space has its own log", personalLog.status === 200 && personalActions.includes("workspace.created"), personalActions.join(","));
check("team activity does not leak into the personal log", !personalActions.includes("member.invited"), personalActions.join(","));

console.log("\n== Removal ==");
const removableRow = members.body.members.find((m) => m.email === viewer.email) || memberRow;
const rosterBefore = members.body.members.length;
const removeOne = await call(`/workspaces/${teamId}/members/${removableRow.id}`, { method: "DELETE", token: owner.token });
check("a member can be removed", removeOne.status === 200, `status ${removeOne.status}`);

const removeTwice = await call(`/workspaces/${teamId}/members/${removableRow.id}`, { method: "DELETE", token: owner.token });
check("removing them twice is a 404", removeTwice.status === 404, `status ${removeTwice.status}`);

const removeOwner = await call(`/workspaces/${teamId}/members/${ownerRow.id}`, { method: "DELETE", token: owner.token });
check("the owner cannot be removed", removeOwner.status === 400, `status ${removeOwner.status}`);

const afterRemoval = await call(`/workspaces/${teamId}/members`, { token: owner.token });
check("the roster shrinks by one", afterRemoval.body?.members?.length === rosterBefore - 1, `${afterRemoval.body?.members?.length} of ${rosterBefore}`);

// Re-inviting somebody who was removed has to work. On a full free plan it is
// refused with a seat-limit message instead, which is also correct.
const reinvite = await call(`/workspaces/${teamId}/members`, { method: "POST", token: owner.token, body: { email: removableRow.email } });
const seatLimitRefusal = reinvite.status === 409 && /limit/i.test(reinvite.body?.error || "");
check(
  "a removed person can be invited again, or the seat limit explains why",
  reinvite.status === 201 || seatLimitRefusal,
  `status ${reinvite.status} ${reinvite.body?.error || ""}`
);

console.log("\n== Leaving ==");
const ownerLeave = await call(`/workspaces/${teamId}/leave`, { method: "POST", token: owner.token });
check("the owner cannot just leave", ownerLeave.status === 400, `status ${ownerLeave.status}`);

const memberLeave = await call(`/workspaces/${teamId}/leave`, { method: "POST", token: member.token });
check("a member can leave", memberLeave.status === 200, `status ${memberLeave.status}`);

const afterLeave = await call(`/workspaces/${teamId}`, { token: member.token });
check("a leaver loses access", afterLeave.status === 404, `status ${afterLeave.status}`);

const personalLeave = await call(`/workspaces/${personal.id}/leave`, { method: "POST", token: owner.token });
check("a personal workspace cannot be left", personalLeave.status === 400, `status ${personalLeave.status}`);

console.log("\n== Ownership transfer ==");
const membersFresh = await call(`/workspaces/${teamId}/members`, { token: owner.token });
const editorRow = membersFresh.body?.members?.find((m) => m.email === editor.email);
check("the editor is still in the team", Boolean(editorRow), editorRow?.role);

const editorTakesOver = await call(`/workspaces/${teamId}/transfer`, {
  method: "POST",
  token: editor.token,
  body: { memberId: editorRow.id },
});
check("only the owner can transfer", editorTakesOver.status === 403, `status ${editorTakesOver.status}`);

const transfer = await call(`/workspaces/${teamId}/transfer`, {
  method: "POST",
  token: owner.token,
  body: { memberId: editorRow.id },
});
check("the owner can transfer", transfer.status === 200, `status ${transfer.status} ${JSON.stringify(transfer.body?.error || "")}`);
check("the new owner is recorded", transfer.body?.owner === editor.user?.id, `${transfer.body?.owner} vs ${editor.user?.id}`);

const personalTransfer = await call(`/workspaces/${personal.id}/transfer`, {
  method: "POST",
  token: owner.token,
  body: { memberId: editorRow.id },
});
check("a personal workspace cannot change hands", personalTransfer.status === 400, `status ${personalTransfer.status}`);

console.log("\n== Listing is workspace scoped ==");
const ownerLists = await call(`/documents?workspaceId=${teamId}`, { token: owner.token });
check("the owner lists the team documents", ownerLists.status === 200 && ownerLists.body?.some((d) => d._id === teamDocId), `${ownerLists.body?.length} docs`);

const memberLists = await call(`/documents?workspaceId=${teamId}`, { token: editor.token });
check("a member lists the same team documents", memberLists.status === 200 && memberLists.body?.some((d) => d._id === teamDocId), `${memberLists.body?.length} docs`);

const outsiderLists = await call(`/documents?workspaceId=${teamId}`, { token: outsider.token });
check("an outsider cannot list a workspace's documents", outsiderLists.status === 404, `status ${outsiderLists.status}`);

const memberOwnList = await call("/documents", { token: editor.token });
check(
  "without a workspace a member still sees only their own",
  !memberOwnList.body?.some((d) => d._id === teamDocId),
  `${memberOwnList.body?.length} personal docs`
);

if (billingOn) {
  const oldOwnerPlan = await call(`/workspaces/${teamId}/plan`, { method: "POST", token: owner.token, body: { plan: "pro" } });
  check("the old owner loses plan rights", oldOwnerPlan.status === 403, `status ${oldOwnerPlan.status}`);

  const newOwnerPlan = await call(`/workspaces/${teamId}/plan`, { method: "POST", token: editor.token, body: { plan: "pro" } });
  check("the new owner gains plan rights", newOwnerPlan.status === 200, `status ${newOwnerPlan.status}`);
}

console.log("\n== Invitations before signup ==");
const pendingEmail = `wsnewbie${stamp}@example.com`;
const invitePending = await call(`/workspaces/${teamId}/members`, {
  method: "POST",
  token: editor.token,
  body: { email: pendingEmail },
});
check("an unknown address becomes an invitation", invitePending.status === 201, `status ${invitePending.status}`);
check("the invitation is pending", invitePending.body?.status === "invited", invitePending.body?.status);
check("the invitation has no user yet", invitePending.body?.user === null, String(invitePending.body?.user));

const invitePendingTwice = await call(`/workspaces/${teamId}/members`, {
  method: "POST",
  token: editor.token,
  body: { email: pendingEmail },
});
check("the same address cannot be invited twice", invitePendingTwice.status === 409, `status ${invitePendingTwice.status}`);

const newbie = await user("wsnewbie");
const newbieWorkspaces = await call("/workspaces", { token: newbie.token });
check("the invitee lands in the workspace on signup", newbieWorkspaces.body?.workspaces?.some((w) => w.id === teamId), `${newbieWorkspaces.body?.workspaces?.length} workspaces`);
const newbieRole = newbieWorkspaces.body?.workspaces?.find((w) => w.id === teamId)?.myRole;
check("the invitee gets the invited role", newbieRole === "member", newbieRole);

console.log("\n== Trashing a workspace ==");
const trashAsAdmin = await call(`/workspaces/${teamId}`, { method: "DELETE", token: owner.token });
check("an admin cannot trash it", trashAsAdmin.status === 403, `status ${trashAsAdmin.status}`);

const trashed = await call(`/workspaces/${teamId}`, { method: "DELETE", token: editor.token });
check("the owner can trash it", trashed.status === 200, `status ${trashed.status}`);
check("trashing is confirmed", trashed.body?.trashed === true, JSON.stringify(trashed.body));

const goneList = await call("/workspaces", { token: editor.token });
check("a trashed workspace leaves the list", !goneList.body?.workspaces?.some((w) => w.id === teamId), "removed from list");

const restore = await call(`/workspaces/${teamId}/restore`, { method: "POST", token: editor.token });
check("it can be restored", restore.status === 200, `status ${restore.status}`);

const backList = await call("/workspaces", { token: editor.token });
check("a restored workspace comes back", backList.body?.workspaces?.some((w) => w.id === teamId), "back in list");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
if (failures) process.exit(1);
console.log(`cleanup: run "node --env-file=.env tests/cleanup-test-data.mjs" to drop the test rows.`);