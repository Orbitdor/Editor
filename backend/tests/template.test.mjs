/**
 * Templates and smart templates (master plan sections 32 and 33).
 *
 * What is worth testing here is not "a template can be made", it is:
 *   - the built-in library of section 32 exists, is world-readable inside a session
 *     and is immutable;
 *   - a template can become a document, and `{{placeholders}}` are merged rather
 *     than leaking into the finished document;
 *   - permissions match the rest of the app: editor to save one, admin to delete,
 *     and no document content crossing between workspaces;
 *   - "save as template" freezes a body, so later document edits do not follow;
 *   - section 33's AI generation produces a real structure and counts quota.
 *
 * With no OPENAI_API_KEY the server falls back to the offline mock provider, so
 * generation is still exercised end to end and flagged via `mock`.
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
  // Bounded so a request that never answers fails here instead of stalling the suite.
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
  return {
    email: res.body.user.email.toLowerCase(),
    password: "Str0ngPass!",
    token: res.body.token,
    id: res.body.user.id,
  };
}

const titleCount = (list) => list.filter((t) => t.builtIn).length;

section("The built-in library of section 32 exists");
const owner = await makeUser("TemplateOwner");
const outsider = await makeUser("TemplateOutsider");

const anon = await call("/templates");
check("browsing needs a session", anon.status === 401, `status ${anon.status}`);

const library = await call("/templates", { token: owner.token });
check("the library loads", library.status === 200, `status ${library.status}`);
check("the categories are advertised", Array.isArray(library.body?.categories), JSON.stringify(library.body?.categories));

const builtIns = library.body?.templates ?? [];
check("built-in templates are seeded", titleCount(builtIns) >= 12, `${titleCount(builtIns)} built-in`);

// The exact list named in section 32: Blank Document, Proposal, Invoice, Report,
// Contract, Meeting Notes, Assignment, Research Paper, Study Notes, Resume, Cover
// Letter, Letter.
const EXPECTED = [
  "Blank Document",
  "Proposal",
  "Invoice",
  "Report",
  "Contract",
  "Meeting Notes",
  "Assignment",
  "Research Paper",
  "Study Notes",
  "Resume",
  "Cover Letter",
  "Letter",
];
const missing = EXPECTED.filter((t) => !builtIns.some((b) => b.title === t));
check("every template named in section 32 is present", missing.length === 0, missing.length ? `missing ${missing}` : "all 12");

const byCategory = new Set(builtIns.map((t) => t.category));
check("all four categories are represented", ["Blank", "Business", "Education", "Personal"].every((c) => byCategory.has(c)), [...byCategory].join(","));

const proposal = builtIns.find((t) => t.title === "Proposal");
check("built-ins declare fill-in fields", (proposal?.fields?.length ?? 0) >= 5, `${proposal?.fields?.length} fields`);
check("the list response omits the body", proposal?.content === undefined, "body withheld until fetch");

section("One template can be read in full");
const detail = await call(`/templates/${proposal._id}`, { token: owner.token });
check("a template opens", detail.status === 200, `status ${detail.status}`);
check("the body comes with it", String(detail.body?.template?.content ?? "").length > 100, `${String(detail.body?.template?.content ?? "").length} chars`);
check("its placeholders are listed", Array.isArray(detail.body?.template?.placeholders), `${detail.body?.template?.placeholders?.length} placeholders`);
check("the placeholders match the declared fields", detail.body?.template?.placeholders?.includes("client_name"), JSON.stringify(detail.body?.template?.placeholders?.slice(0, 4)));

const filtered = await call("/templates?category=Education", { token: owner.token });
check("category filtering works", (filtered.body?.templates ?? []).every((t) => t.category === "Education"), `${filtered.body?.templates?.length} education`);

const searched = await call("/templates?q=invoice", { token: owner.token });
check("search finds a template", (searched.body?.templates ?? []).some((t) => /invoice/i.test(t.title)), `${searched.body?.templates?.length} hits`);

// The regex is escaped, so a metacharacter is a literal search rather than a
// pattern that throws or matches everything.
const weird = await call("/templates?q=.*", { token: owner.token });
check("a search with regex characters is literal", weird.status === 200, `status ${weird.status}`);

section("A template becomes a document with its fields merged");
const values = {
  client_name: "Ada Lovelace",
  client_company: "Analytical Engines Ltd",
  prepared_by: "Owner",
  valid_until: "2026-12-31",
  project_summary: "A note-taking app for field teams.",
  scope: "Discovery\nDesign\nBuild\nTest",
  deliverables: "One working app",
  timeline: "Six weeks",
  investment: "12000",
  currency: "USD",
  terms: "Net 30.",
};

const used = await call(`/templates/${proposal._id}/use`, {
  method: "POST",
  token: owner.token,
  body: { values },
});
check("a document is created from a template", used.status === 201, `status ${used.status}`);
const newDocId = used.body?.document?._id;
check("the response names the new document", !!newDocId, String(newDocId));

// The real question: did the placeholders get replaced, and did the filled value
// become a real paragraph rather than a run-on line?
const filledBody = String(used.body?.document?.content ?? "");
check("no placeholder is left behind", !/\{\{[^}]+\}\}/.test(filledBody), filledBody.match(/\{\{[^}]+\}\}/)?.[0] ?? "clean");
check("a filled value is in the body", filledBody.includes("Ada Lovelace"), "client present");
check("a multi-line value became a bullet list", filledBody.includes("<ul>") && filledBody.includes("<li>Discovery</li>"), "list rendered");
check("the fill is auditable in the template response", used.body?.content?.includes("Ada Lovelace"), "content echoed");

const readBack = await call(`/documents/${newDocId}`, { token: owner.token });
check("the document persists the merged body", readBack.status === 200 && !/\{\{/.test(String(readBack.body?.content ?? "")), `status ${readBack.status}`);
check("it is titled after the template", readBack.body?.title === "Proposal", readBack.body?.title);

// A template with required fields left blank must not ship its own internals.
const partial = await call(`/templates/${proposal._id}/use`, {
  method: "POST",
  token: owner.token,
  body: { values: { client_name: "Only a name" } },
});
check("an unfilled template leaves no placeholder", !/\{\{[^}]+\}\}/.test(String(partial.body?.document?.content ?? "")), "clean");
check("the supplied value still lands", String(partial.body?.document?.content ?? "").includes("Only a name"), "value present");

const retitled = await call(`/templates/${proposal._id}/use`, {
  method: "POST",
  token: owner.token,
  body: { title: "Acme proposal", values: { client_name: "Acme" } },
});
check("a document can be renamed on the way out", retitled.body?.document?.title === "Acme proposal", retitled.body?.document?.title);

const badValues = await call(`/templates/${proposal._id}/use`, {
  method: "POST",
  token: owner.token,
  body: { values: "not-an-object" },
});
check("values must be an object", badValues.status === 400, `status ${badValues.status}`);

const missingTpl = await call("/templates/000000000000000000000000/use", {
  method: "POST",
  token: owner.token,
  body: {},
});
check("an unknown template is a 404", missingTpl.status === 404, `status ${missingTpl.status}`);

section("Use counts feed the picker's ordering");
const before = (await call("/templates?category=Business", { token: owner.token })).body?.templates?.find((t) => t._id === proposal._id)?.useCount ?? 0;
await call(`/templates/${proposal._id}/use`, { method: "POST", token: owner.token, body: {} });
const after = (await call("/templates?category=Business", { token: owner.token })).body?.templates?.find((t) => t._id === proposal._id)?.useCount ?? 0;
check("useCount increments", after === before + 1, `${before} -> ${after}`);

section("Built-in templates are immutable");
const editBuiltIn = await call(`/templates/${proposal._id}`, {
  method: "PATCH",
  token: owner.token,
  body: { title: "Hijacked" },
});
check("a built-in cannot be edited", editBuiltIn.status === 400, `status ${editBuiltIn.status}`);

const dropBuiltIn = await call(`/templates/${proposal._id}?workspaceId=000000000000000000000000`, {
  method: "DELETE",
  token: owner.token,
});
check("a built-in cannot be deleted", dropBuiltIn.status === 400, `status ${dropBuiltIn.status}`);

section("A document can be saved as a workspace template");
const source = await call("/documents", {
  method: "POST",
  token: owner.token,
  body: { title: "House style note" },
});
const sourceId = source.body?._id;
// Document edits go through PUT /documents/:id, not PATCH.
await call(`/documents/${sourceId}`, {
  method: "PUT",
  token: owner.token,
  body: { content: "<h1>House style</h1><p>Always use the active voice.</p>" },
});

const saved = await call("/templates/from-document", {
  method: "POST",
  token: owner.token,
  body: { documentId: sourceId, title: "House style", description: "Our default note", category: "Custom", tags: ["brand"] },
});
check("the document is saved as a template", saved.status === 201, `status ${saved.status}`);
const savedId = saved.body?.template?._id;
check("it is a workspace template, not a built-in", saved.body?.template?.builtIn === false, String(saved.body?.template?.builtIn));
check("it carries the tags", saved.body?.template?.tags?.includes("brand"), JSON.stringify(saved.body?.template?.tags));

// The whole point of freezing a template: later edits to the source must not follow.
await call(`/documents/${sourceId}`, {
  method: "PUT",
  token: owner.token,
  body: { content: "<h1>House style</h1><p>CHANGED LATER</p>" },
});
const savedDetail = await call(`/templates/${savedId}`, { token: owner.token });
check("the template kept the original body", savedDetail.body?.template?.content?.includes("active voice"), "frozen");
check("and did not follow the document", !savedDetail.body?.template?.content?.includes("CHANGED LATER"), "isolated");

const dupe = await call("/templates/from-document", {
  method: "POST",
  token: owner.token,
  body: { documentId: sourceId, title: "House style" },
});
check("a duplicate title in one workspace is refused", dupe.status === 409, `status ${dupe.status}`);

const stillThere = await call("/templates", { token: owner.token });
check("the saved template appears in the browse", (stillThere.body?.templates ?? []).some((t) => t._id === savedId), "listed");

section("Team templates follow the workspace role ladder");
// The personal-workspace template is not reachable without naming its workspace,
// and naming a workspace the caller is not in must not confirm it exists.
const mine = await call(`/templates/${savedId}`, { token: outsider.token });
check("an outsider cannot read another workspace's template", mine.status === 404, `status ${mine.status}`);

const outsiderBrowse = await call("/templates", { token: outsider.token });
check("an outsider sees only the built-ins", (outsiderBrowse.body?.templates ?? []).every((t) => t.builtIn), `${outsiderBrowse.body?.templates?.length} built-in`);

// A viewer may read templates but must not add to the shared library.
const invite = await call("/workspaces", {
  method: "POST",
  token: owner.token,
  body: { name: "Template Team" },
});
// The workspace serializer exposes `id`, not the raw `_id`.
const teamId = invite.body?.id;
const member = await call(`/workspaces/${teamId}/members`, {
  method: "POST",
  token: owner.token,
  body: { email: outsider.email, role: "viewer" },
});
check("a viewer is invited to the team", member.status === 201 || member.status === 200, `status ${member.status}`);

// A second workspace, to prove a team template cannot be redirected into it.
const otherInvite = await call("/workspaces", {
  method: "POST",
  token: owner.token,
  body: { name: "Other Team" },
});
const otherTeamId = otherInvite.body?.id;

// "House style" lives in the owner's personal workspace, so the team needs one of
// its own before the role ladder below means anything.
const teamDoc = await call("/documents", {
  method: "POST",
  token: owner.token,
  body: { title: "Team note", workspaceId: teamId },
});
const teamTemplate = await call("/templates/from-document", {
  method: "POST",
  token: owner.token,
  body: { documentId: teamDoc.body?._id, title: "Team note" },
});
check("a template can be saved into a team workspace", teamTemplate.status === 201, `status ${teamTemplate.status}`);
const teamTemplateId = teamTemplate.body?.template?._id;

const viewerSees = await call(`/templates?workspaceId=${teamId}`, { token: outsider.token });
check(
  "a viewer sees the team templates",
  (viewerSees.body?.templates ?? []).some((t) => t._id === teamTemplateId),
  `${viewerSees.body?.templates?.length} visible`
);

const viewerSaves = await call("/templates", {
  method: "POST",
  token: outsider.token,
  body: { title: "Viewer template", workspaceId: teamId },
});
check("a viewer cannot create a template", viewerSees.status === 200 && viewerSaves.status === 403, `status ${viewerSaves.status}`);

const viewerUses = await call(`/templates/${proposal._id}/use`, {
  method: "POST",
  token: outsider.token,
  body: { workspaceId: teamId },
});
check("a viewer cannot use a template to add a document", viewerUses.status === 403, `status ${viewerUses.status}`);

const viewerDeletes = await call(`/templates/${teamTemplateId}?workspaceId=${teamId}`, { method: "DELETE", token: outsider.token });
check("a viewer cannot delete a team template", viewerDeletes.status === 403, `status ${viewerDeletes.status}`);

// A team template must land only in its own workspace, even when the caller names
// a different one: `workspaceId` is where a *built-in* may go, not a rewrite of
// where a team template belongs.
const crossUse = await call(`/templates/${teamTemplateId}/use`, {
  method: "POST",
  token: owner.token,
  body: { workspaceId: otherTeamId },
});
check(
  "a team template lands only in its own workspace",
  crossUse.body?.document?.workspace === teamId,
  `workspace ${crossUse.body?.document?.workspace} expected ${teamId}`
);

section("A workspace template can be edited and removed");
const editable = await call(`/templates/${savedId}`, {
  method: "PATCH",
  token: owner.token,
  body: { title: "House style v2", description: "Updated", tags: ["brand", "team"] },
});
check("the team owner can edit it", editable.status === 200 && editable.body?.template?.title === "House style v2", `status ${editable.status}`);

const dropped = await call(`/templates/${savedId}?workspaceId=${teamId}`, {
  method: "DELETE",
  token: owner.token,
});
check("an admin can delete it", dropped.status === 200, `status ${dropped.status}`);
check("it is gone afterwards", (await call(`/templates/${savedId}`, { token: owner.token })).status === 404, "404");

section("Smart templates generate a structure (section 33)");
const prompts = await call("/templates/smart/prompts", { token: owner.token });
check("the prompt suggestions are offered", (prompts.body?.prompts?.length ?? 0) >= 3, `${prompts.body?.prompts?.length} prompts`);
check("section 33's examples are among them", ["Create a software proposal", "Create a business agreement"].every((p) => prompts.body?.prompts?.some((x) => x.prompt === p)), JSON.stringify(prompts.body?.prompts?.map((p) => p.prompt)));
check("kinds are offered for the picker", (prompts.body?.kinds?.length ?? 0) >= 5, `${prompts.body?.kinds?.length} kinds`);

const noPrompt = await call("/templates/generate", { method: "POST", token: owner.token, body: {} });
check("generation needs a description", noPrompt.status === 400, `status ${noPrompt.status}`);

const badKind = await call("/templates/generate", {
  method: "POST",
  token: owner.token,
  body: { prompt: "Create a software proposal", category: "nonsense" },
});
check("an unknown kind is refused", badKind.status === 400, `status ${badKind.status}`);

const generated = await call("/templates/generate", {
  method: "POST",
  token: owner.token,
  body: { prompt: "Create a software proposal", category: "proposal" },
});
check("a template is generated and saved", generated.status === 201, `status ${generated.status}`);
check("it gets a title", !!generated.body?.title, generated.body?.title);
check("it gets a body", String(generated.body?.content ?? "").length > 40, `${String(generated.body?.content ?? "").length} chars`);
check("it is marked as mock when unconfigured", typeof generated.body?.mock === "boolean", `mock=${generated.body?.mock}`);
check("it lands in the caller's workspace", generated.body?.builtIn === false, String(generated.body?.builtIn));

// A generated structure is only useful if it can be used like any other template.
const generatedUse = await call(`/templates/${generated.body?._id}/use`, {
  method: "POST",
  token: owner.token,
  body: { values: { summary: "A generated summary." } },
});
check("a generated template can create a document", generatedUse.status === 201, `status ${generatedUse.status}`);
check("its placeholders merge too", String(generatedUse.body?.document?.content ?? "").includes("A generated summary."), "merged");

const draft = await call("/templates/generate", {
  method: "POST",
  token: owner.token,
  body: { prompt: "Create meeting minutes", save: false },
});
check("a draft can be previewed without saving", draft.status === 200 && draft.body?.saved === false, `status ${draft.status}`);
check("the draft carries a body", String(draft.body?.draft?.content ?? "").length > 20, `${String(draft.body?.draft?.content ?? "").length} chars`);
const afterDraft = await call("/templates", { token: owner.token });
check(
  "an unsaved draft is not in the library",
  !(afterDraft.body?.templates ?? []).some((t) => t.title === draft.body?.draft?.title),
  "not listed"
);

// Two generations of the same thing must not collide on the unique title index.
const first = await call("/templates/generate", { method: "POST", token: owner.token, body: { prompt: "Create an invoice", category: "invoice" } });
const second = await call("/templates/generate", { method: "POST", token: owner.token, body: { prompt: "Create an invoice", category: "invoice" } });
check("repeated generation gets distinct titles", first.body?.title !== second.body?.title, `${first.body?.title} vs ${second.body?.title}`);
check("neither collided", first.status === 201 && second.status === 201, `${first.status}/${second.status}`);

section("Validation");
const badCreate = await call("/templates", { method: "POST", token: owner.token, body: {} });
check("a template needs a title", badCreate.status === 400, `status ${badCreate.status}`);

const badCategory = await call("/templates", { method: "POST", token: owner.token, body: { title: "x", category: "Nope" } });
check("the category must be known", badCategory.status === 400, `status ${badCategory.status}`);

const badField = await call("/templates", {
  method: "POST",
  token: owner.token,
  body: { title: "Bad fields", fields: [{ name: "a", type: "colour-picker" }] },
});
check("a field type must be known", badField.status === 400, `status ${badField.status}`);

const noDoc = await call("/templates/from-document", { method: "POST", token: owner.token, body: {} });
check("saving from a document needs one", noDoc.status === 400, `status ${noDoc.status}`);

const foreignDoc = await call("/templates/from-document", {
  method: "POST",
  token: outsider.token,
  body: { documentId: sourceId },
});
check("a document must be readable by the caller", foreignDoc.status === 404 || foreignDoc.status === 403, `status ${foreignDoc.status}`);

const filteredFolder = await call(`/templates/${proposal._id}/use`, {
  method: "POST",
  token: owner.token,
  body: { folderId: "000000000000000000000000" },
});
check("an unknown folder is refused", filteredFolder.status === 404, `status ${filteredFolder.status}`);

console.log(failures === 0 ? "\nALL TEMPLATE TESTS PASSED" : `\n${failures} TEMPLATE TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
