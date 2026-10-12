"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Plus,
  FileText,
  Star,
  Trash2,
  RotateCcw,
  FolderOpen,
  LayoutTemplate,
  Search,
  Users,
} from "lucide-react";

import { getDocs, createDoc, trashDoc, restoreDoc, starDoc, getSharedWithMe } from "@/lib/api";
import { getUser, clearSession } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import NotificationBell from "@/components/NotificationBell";
import UserMenu from "@/components/UserMenu";
import WorkspacePanel from "@/components/WorkspacePanel";
import FolderTree from "@/components/FolderTree";
import TemplatePicker from "@/components/TemplatePicker";
import { cn } from "@/lib/utils";

/** Short description of what each access level allows, shown on shared cards. */
const ROLE_HINTS = {
  editor: "Can edit",
  commenter: "Can comment",
  viewer: "View only",
};

const ROLE_STYLES = {
  editor: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  commenter: "bg-blue-50 text-blue-700 ring-blue-200",
  viewer: "bg-zinc-100 text-zinc-600 ring-zinc-200",
};

function timeAgo(date) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function excerpt(doc) {
  const html =
    doc.plainText ??
    doc.content ??
    "";
  if (!html) return "";
  const text = html
    .replace(/<div[^>]*data-pagebreak[^>]*><\/div>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

const SIDEBAR_ITEMS = [
  { key: "all", label: "All documents", icon: FolderOpen },
  { key: "starred", label: "Starred", icon: Star },
  { key: "shared", label: "Shared with me", icon: Users },
  { key: "trash", label: "Trash", icon: Trash2 },
];

/** Normalize a `/shared` entry to the same shape the own-docs list uses. */
function toSharedCard(share) {
  return {
    _id: share.document.id,
    title: share.document.title,
    plainText: share.document.snippet || "",
    updatedAt: share.document.updatedAt,
    role: share.role,
  };
}

export default function Dashboard() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState("all");
  const [query, setQuery] = useState("");
  const [workspaceId, setWorkspaceId] = useState(null);
// The folder the sidebar has drilled into; null means "the whole workspace".
const [folderId, setFolderId] = useState(null);
// The caller's role in the workspace currently open, reported by the workspace
// panel. Null until it loads, and while looking at "Shared with me", which is not
// a workspace at all.
const [activeRole, setActiveRole] = useState(null);
// Adding a document needs editor or above. Owning a personal space always passes.
const canCreate = activeRole === null || ["owner", "admin", "editor"].includes(activeRole);

  // "shared" is a different endpoint with a different payload, so the fetch is
  // normalized to the same card shape the rest of the page already renders.
  // A workspace id is only meaningful for your own documents: "Shared with me" is
  // already everything other people have shared, across every workspace.
  const load = useCallback(() => {
    if (scope === "shared") {
      return getSharedWithMe().then((list) => list.map(toSharedCard));
    }
    // Picking a folder narrows the list; clearing it shows everything again.
    // A search always spans the workspace, because a search that silently
    // ignored the folder you were looking in would be baffling.
    const drilled = folderId && !query;
    return getDocs({
      scope: scope === "all" ? undefined : scope,
      q: query || undefined,
      workspaceId: workspaceId || undefined,
      folderId: drilled ? folderId : undefined,
      unfiled: drilled ? false : undefined,
    });
  }, [scope, query, workspaceId, folderId]);

  // Search only applies to documents you own; the shared endpoint has no `q`.
  const searchShown = scope !== "shared" && Boolean(query);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setMe(getUser()));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      setLoading(true);
      load()
        .then((data) => {
          if (!cancelled) setDocs(data);
        })
        .catch((err) => {
          console.error(err);
          // The session lives in an HttpOnly cookie, so the only way to learn it
          // has gone is for the API to say 401. That is the redirect trigger.
          if (err.status === 401) {
            clearSession();
            router.replace("/login");
            return;
          }
          if (!cancelled) toast.error("Could not load documents");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [load, router]);

  const [templatePicker, setTemplatePicker] = useState(false);

  async function handleNewDoc() {
    // The API would refuse a viewer anyway; saying so up front beats a toast.
    if (!canCreate) {
      toast.error(`Your ${activeRole} role in this workspace cannot add documents`);
      return;
    }
    try {
      // A new document belongs to the workspace currently in view, and is filed
      // into the folder the sidebar has drilled into, when there is one.
      const body =
        workspaceId && scope !== "shared" ? { workspaceId, folderId: folderId || undefined } : {};
      const doc = await createDoc(body);
      router.push(`/editor/${doc._id}`);
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not create document");
    }
  }

  async function handleStar(doc) {
    try {
      const updated = await starDoc(doc._id, !doc.starred);
      setDocs((list) =>
        scope === "starred" && !updated.starred
          ? list.filter((d) => d._id !== doc._id)
          : list.map((d) => (d._id === doc._id ? updated : d))
      );
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not update star");
    }
  }

  async function handleTrash(doc) {
    if (scope !== "trash" && !window.confirm(`Move "${doc.title}" to trash?`)) {
      return;
    }
    const action = scope === "trash" ? restoreDoc : trashDoc;
    try {
      await action(doc._id);
      setDocs((list) => list.filter((d) => d._id !== doc._id));
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not update document");
    }
  }

  const inTrash = scope === "trash";
  // Star and trash belong to the document owner, so they are hidden on shared
  // documents and on a team member's documents created by somebody else.
  const shared = scope === "shared";

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 gap-8 px-6 py-10">
      <aside className="w-52 shrink-0">
        <nav className="sticky top-10 flex flex-col gap-1">
          {SIDEBAR_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = scope === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  setScope(item.key);
                  // Starred, Trash and Shared are cross-folder views, so a
                  // leftover folder filter would quietly empty them.
                  setFolderId(null);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-blue-50 text-blue-700"
                    : "text-zinc-600 hover:bg-zinc-100"
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </button>
            );
          })}
          <FolderTree
            workspaceId={workspaceId}
            selectedId={folderId}
            onSelect={setFolderId}
            canOrganise={!shared && scope !== "shared"}
          />
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
        <WorkspacePanel activeId={workspaceId} onSelect={setWorkspaceId} onActiveRole={setActiveRole} />

        <div className="mb-6 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">
              {SIDEBAR_ITEMS.find((i) => i.key === scope)?.label}
            </h1>
            <p className="text-sm text-zinc-500">
              {me?.name ? `Signed in as ${me.name}` : "Loading account..."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!shared ? (
              <label className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search documents..."
                  className="h-9 w-44 rounded-md border border-zinc-200 bg-white pl-8 pr-3 text-sm outline-none focus:border-blue-400"
                />
              </label>
            ) : null}
            <NotificationBell />
            <UserMenu user={me} />
            <Button variant="outline" onClick={() => setTemplatePicker(true)} title="Start from a template">
              <LayoutTemplate />
              <span className="hidden sm:inline">Templates</span>
            </Button>
            <Button onClick={handleNewDoc} disabled={!canCreate} title={canCreate ? undefined : `Your ${activeRole} role cannot add documents`}>
              <Plus />
              <span className="hidden sm:inline">New document</span>
            </Button>
          </div>
        </div>

        {loading ? (
          <p className="text-zinc-500">Loading...</p>
        ) : docs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-zinc-300 px-6 py-16 text-center">
            <FileText className="size-10 text-zinc-400" />
            <p className="text-zinc-500">
              {inTrash
                ? "Trash is empty."
                : shared
                  ? "Nothing has been shared with you yet."
                  : searchShown
                    ? "No documents match your search."
                    : "No documents yet. Click \"New document\" to create one."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {docs.map((doc) => {
              const preview = excerpt(doc) || "Empty document";
              const isMine = String(doc.owner) === String(me?.id);
              return (
                <Link
                  key={doc._id}
                  href={`/editor/${doc._id}`}
                  className="group relative rounded-lg border border-zinc-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md"
                >
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <h2 className="truncate font-medium group-hover:text-blue-600">
                      {doc.title}
                    </h2>
                    {shared ? (
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ring-1 ring-inset",
                          ROLE_STYLES[doc.role] || ROLE_STYLES.viewer
                        )}
                      >
                        {doc.role}
                      </span>
                    ) : isMine ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleStar(doc);
                        }}
                        title={doc.starred ? "Unstar" : "Star"}
                        className={cn(
                          "shrink-0 rounded p-1 transition-colors",
                          doc.starred
                            ? "text-yellow-500 hover:bg-yellow-50"
                            : "text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500"
                        )}
                      >
                        <Star className="size-4" fill={doc.starred ? "currentColor" : "none"} />
                      </button>
                    ) : null}
                  </div>
                  <p className="line-clamp-3 whitespace-pre-wrap text-sm text-zinc-500">
                    {preview}
                  </p>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-xs text-zinc-400">
                      {shared ? ROLE_HINTS[doc.role] : `Edited ${timeAgo(doc.updatedAt)}`}
                    </span>
                    {!shared && isMine ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleTrash(doc);
                        }}
                        title={inTrash ? "Restore" : "Move to trash"}
                        className="rounded p-1 text-zinc-300 transition-colors hover:bg-zinc-100 hover:text-zinc-600"
                      >
                        {inTrash ? (
                          <RotateCcw className="size-4" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </button>
                    ) : null}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>

      <TemplatePicker
        open={templatePicker}
        onOpenChange={setTemplatePicker}
        workspaceId={scope === "shared" ? undefined : workspaceId}
        folderId={folderId || undefined}
        canCreate={canCreate}
        activeRole={activeRole}
      />
    </div>
  );
}