"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, User, Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  getWorkspaces,
  createWorkspace,
  getWorkspaceMembers,
  inviteWorkspaceMember,
  setWorkspaceMemberRole,
  removeWorkspaceMember,
  getWorkspaceActivity,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Workspace switcher and management panel (master plan sections 36, 46 and 49).
 *
 * A workspace is the unit that owns documents and the seat count, so switching
 * here changes what the dashboard lists. Everything that needs an admin or owner
 * is hidden rather than disabled-and-failing, because the server would refuse it
 * anyway and the message would be noise.
 */

const ROLE_OPTIONS = ["admin", "editor", "member", "viewer"];

/** What each role is allowed to do, shown next to the picker. */
const ROLE_HINTS = {
  owner: "Full control, including billing and deletion",
  admin: "Manage members, settings and the activity log",
  editor: "Create and edit documents",
  member: "Read documents and comment",
  viewer: "Read only",
};

const ASSIGNABLE_ROLES = ROLE_OPTIONS.filter((r) => r !== "owner");

/** Human sentence for one audit action. */
const ACTION_TEXT = {
  "workspace.created": "created the workspace",
  "workspace.updated": "updated workspace settings",
  "workspace.deleted": "moved the workspace to trash",
  "member.invited": "invited a member",
  "member.joined": "joined the workspace",
  "member.role_changed": "changed a role",
  "member.removed": "removed a member",
  "document.created": "created a document",
  "document.updated": "edited a document",
  "document.trashed": "moved a document to trash",
  "document.restored": "restored a document",
  "document.deleted": "deleted a document",
  "document.shared": "shared a document",
  "share.revoked": "removed a share",
  "integration.connected": "connected an integration",
  "integration.disconnected": "disconnected an integration",
  "billing.plan_changed": "changed the plan",
};

function describe(entry) {
  const action = ACTION_TEXT[entry.action] || entry.action;
  const who = entry.actorName || "Someone";
  const what = entry.resource?.name ? ` “${entry.resource.name}”` : "";
  return `${who} ${action}${what}`;
}

function when(date) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function WorkspacePanel({ activeId, onSelect, onActiveRole }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [panelFor, setPanelFor] = useState(null);

  const active = workspaces.find((w) => w.id === activeId) || null;

  // The dashboard needs to know what the current role allows before it offers
  // "New document"; otherwise a viewer gets a 403 the moment they click.
  useEffect(() => {
    if (!onActiveRole) return;
    onActiveRole(active?.myRole ?? null);
  }, [active, onActiveRole]);

  const load = useCallback(async () => {
    try {
      const data = await getWorkspaces();
      setWorkspaces(data.workspaces || []);
      return data.workspaces || [];
    } catch (err) {
      console.error(err);
      toast.error("Could not load workspaces");
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred by a frame so the state update lands after this effect returns,
    // which is the pattern the rest of the app uses for its initial loads.
    const raf = requestAnimationFrame(() => load());
    return () => cancelAnimationFrame(raf);
  }, [load]);

  // Land on the personal workspace the first time, so the dashboard is never
  // pointed at nothing.
  useEffect(() => {
    if (loading || activeId || !workspaces.length) return;
    const personal = workspaces.find((w) => w.isPersonal) || workspaces[0];
    if (personal) onSelect(personal.id);
  }, [loading, workspaces, activeId, onSelect]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const workspace = await createWorkspace(name);
      setNewName("");
      const list = await load();
      const created = list.find((w) => w.id === workspace.id);
      if (created) {
        onSelect(created.id);
        setPanelFor(created.id);
      }
      toast.success(`Created ${workspace.name}`);
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not create workspace");
    } finally {
      setCreating(false);
    }
  }

  const isTeam = Boolean(active && !active.isPersonal);
  // Admins and owners run the workspace; viewers and members just see documents.
  const canManage = isTeam && ["owner", "admin"].includes(active.myRole);

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
          Workspace
        </span>
        {loading ? (
          <Loader2 className="size-4 animate-spin text-zinc-400" />
        ) : (
          workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => onSelect(w.id)}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                w.id === activeId
                  ? "border-blue-200 bg-blue-50 text-blue-700"
                  : "border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50"
              )}
            >
              {w.isPersonal ? (
                <User className="size-3.5" />
              ) : (
                <Building2 className="size-3.5" />
              )}
              {w.name}
              {w.plan === "pro" ? (
                <Badge className="ml-1 bg-violet-100 px-1.5 text-[10px] text-violet-700 ring-1 ring-violet-200">
                  Pro
                </Badge>
              ) : null}
            </button>
          ))
        )}

        <form
          className="ml-auto flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            handleCreate();
          }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New team name"
            maxLength={120}
            aria-label="New team name"
            className="h-8 w-36 rounded-md border border-zinc-200 bg-white px-2.5 text-sm outline-none focus:border-blue-400"
          />
          <Button type="submit" size="sm" variant="outline" disabled={creating || !newName.trim()}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">Create team</span>
          </Button>
        </form>
      </div>

      {isTeam ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
          <Badge variant="secondary">{active.myRole}</Badge>
          <span>
            {active.stats?.documents || 0} of {active.limits?.maxDocuments} documents
          </span>
          <span aria-hidden>·</span>
          <span>
            {active.stats?.members || 0} of {active.limits?.maxMembers} seats
          </span>
          {canManage ? (
            <button
              type="button"
              onClick={() => setPanelFor(panelFor === active.id ? null : active.id)}
              className="ml-auto cursor-pointer text-blue-600 hover:underline"
            >
              {panelFor === active.id ? "Hide members" : "Manage members"}
            </button>
          ) : null}
        </div>
      ) : null}

      {canManage && panelFor === active?.id ? (
        <MembersAndActivity
          workspaceId={active.id}
          canRemove={active.myRole === "owner"}
          onChanged={load}
        />
      ) : null}

      {panelFor && !canManage ? null : null}
    </div>
  );
}

/**
 * The admin view: roster with role changes, plus the audit trail.
 * Kept in one panel because both are the same "who is doing what" question.
 */
function MembersAndActivity({ workspaceId, canRemove, onChanged }) {
  const [members, setMembers] = useState([]);
  const [entries, setEntries] = useState([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("members");

  const load = useCallback(async () => {
    try {
      const [memberData, activityData] = await Promise.all([
        getWorkspaceMembers(workspaceId),
        getWorkspaceActivity(workspaceId, { limit: 25 }),
      ]);
      setMembers(memberData.members || []);
      setEntries(activityData.entries || []);
    } catch (err) {
      console.error(err);
      toast.error("Could not load workspace details");
    }
  }, [workspaceId]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => load());
    return () => cancelAnimationFrame(raf);
  }, [load]);

  async function run(action, successMessage) {
    setBusy(true);
    try {
      await action();
      await load();
      if (onChanged) await onChanged();
      if (successMessage) toast.success(successMessage);
    } catch (err) {
      console.error(err);
      toast.error(err.message || "That did not work");
    } finally {
      setBusy(false);
    }
  }

  async function invite() {
    const clean = email.trim();
    if (!clean) return;
    await run(() => inviteWorkspaceMember(workspaceId, clean, role), `Invited ${clean}`);
    setEmail("");
  }

  return (
    <div className="mt-3 rounded-lg border border-zinc-200 bg-white">
      <div className="flex items-center gap-1 border-b border-zinc-100 px-3 py-2">
        {["members", "activity"].map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "cursor-pointer rounded px-2.5 py-1 text-sm font-medium capitalize",
              tab === key ? "bg-zinc-100 text-zinc-900" : "text-zinc-500 hover:bg-zinc-50"
            )}
          >
            {key === "members" ? `Members (${members.length})` : "Activity"}
          </button>
        ))}
      </div>

      {tab === "members" ? (
        <div className="p-3">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  invite();
                }
              }}
              placeholder="teammate@example.com"
              aria-label="Teammate email"
              className="h-8 flex-1 min-w-48 rounded-md border border-zinc-200 px-2.5 text-sm outline-none focus:border-blue-400"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              aria-label="Role to invite"
              className="h-8 rounded-md border border-zinc-200 bg-white px-2 text-sm outline-none focus:border-blue-400"
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={invite} disabled={busy || !email.trim()}>
              Invite
            </Button>
          </div>
          <p className="mb-3 text-xs text-zinc-400">{ROLE_HINTS[role]}</p>

          <ul className="divide-y divide-zinc-100">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{m.name || m.email}</p>
                  <p className="truncate text-xs text-zinc-500">
                    {m.email}
                    {m.status === "invited" ? " · invitation pending" : ""}
                  </p>
                </div>
                {m.role === "owner" ? (
                  <Badge className="bg-amber-50 text-amber-700 ring-1 ring-amber-200">owner</Badge>
                ) : (
                  <select
                    value={m.role}
                    aria-label={`Role for ${m.email}`}
                    disabled={busy}
                    onChange={(e) =>
                      run(
                        () => setWorkspaceMemberRole(workspaceId, m.id, e.target.value),
                        `${m.email} is now ${e.target.value}`
                      )
                    }
                    className="h-8 rounded-md border border-zinc-200 bg-white px-2 text-sm outline-none focus:border-blue-400"
                  >
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                )}
                {m.role !== "owner" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => removeWorkspaceMember(workspaceId, m.id),
                        `Removed ${m.email}`
                      )
                    }
                    title={canRemove ? "Remove from workspace" : "Remove from workspace"}
                    className="cursor-pointer rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-50 hover:text-red-600 disabled:opacity-50"
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {entries.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-zinc-500">
              Nothing has happened here yet.
            </li>
          ) : (
            entries.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="truncate text-sm text-zinc-700">{describe(entry)}</span>
                <span className="shrink-0 text-xs text-zinc-400">{when(entry.createdAt)}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}