"use client";

import { useCallback, useEffect, useState } from "react";
import { Folder, FolderPlus, ChevronRight, ChevronDown, Trash2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import {
  createFolder,
  getFolders,
  getTrashedFolders,
  restoreFolder,
  trashFolder,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Folder tree for the dashboard sidebar (master plan section 11: "Work / Projects
 * / Reports / Contracts").
 *
 * Folders belong to a workspace, so the tree reloads whenever the workspace
 * changes. Selecting a folder narrows the document list below it; "All documents"
 * clears the selection. The permission bar comes from the server, and a viewer
 * simply never sees the create control because the API would refuse it anyway.
 */
export default function FolderTree({ workspaceId, selectedId, onSelect, canOrganise = true }) {
  const [folders, setFolders] = useState([]);
  const [trashed, setTrashed] = useState([]);
  const [showTrash, setShowTrash] = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [live, bin] = await Promise.all([
        getFolders({ workspaceId: workspaceId || undefined }),
        getTrashedFolders({ workspaceId: workspaceId || undefined }).catch(() => ({ folders: [] })),
      ]);
      setFolders(live.folders || []);
      setTrashed(bin.folders || []);
    } catch (err) {
      // A workspace the caller cannot read is not an error worth shouting about;
      // it just means there is no tree to show.
      if (err.status !== 404) console.error(err);
      setFolders([]);
      setTrashed([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => load());
    return () => cancelAnimationFrame(raf);
  }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    try {
      await createFolder({ name: clean, workspaceId: workspaceId || undefined });
      setName("");
      setCreating(false);
      await load();
    } catch (err) {
      toast.error(err.message || "Could not create that folder");
    } finally {
      setBusy(false);
    }
  }

  async function handleTrash(id) {
    try {
      await trashFolder(id);
      // Trashing the folder someone is looking inside would leave the list empty
      // with no explanation, so fall back to the whole workspace.
      if (selectedId === id) onSelect(null);
      await load();
      toast.success("Folder moved to trash");
    } catch (err) {
      toast.error(err.message || "Could not trash that folder");
    }
  }

  async function handleRestore(id) {
    try {
      await restoreFolder(id);
      await load();
    } catch (err) {
      toast.error(err.message || "Could not restore that folder");
    }
  }

  function toggle(id) {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  }

  return (
    <div className="mt-4">
      <div className="mb-1 flex items-center justify-between px-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Folders</span>
        {canOrganise ? (
          <button
            type="button"
            onClick={() => setCreating((v) => !v)}
            className="cursor-pointer rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
            title="New folder"
            data-testid="new-folder"
          >
            <FolderPlus className="size-4" />
          </button>
        ) : null}
      </div>

      {creating ? (
        <form onSubmit={handleCreate} className="px-2 pb-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => !name.trim() && setCreating(false)}
            placeholder="Folder name"
            maxLength={120}
            className="h-8 w-full rounded-md border border-zinc-200 px-2 text-sm outline-none focus:border-blue-400"
          />
          <div className="mt-1.5 flex gap-1">
            <Button type="submit" size="sm" disabled={busy || !name.trim()} className="h-7 flex-1">
              Create
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => {
                setName("");
                setCreating(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {!folders.length && !creating ? (
        <p className="px-3 py-1 text-xs text-zinc-400">
          {canOrganise ? "No folders yet." : "No folders here."}
        </p>
      ) : null}

      <ul className="flex flex-col gap-0.5">
        {folders.map((folder) => (
          <FolderRow
            key={folder._id}
            folder={folder}
            depth={0}
            collapsed={collapsed}
            onToggle={toggle}
            selectedId={selectedId}
            onSelect={onSelect}
            canOrganise={canOrganise}
            onTrash={handleTrash}
          />
        ))}
      </ul>

      {trashed.length ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowTrash((v) => !v)}
            className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100"
          >
            {showTrash ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Folder trash ({trashed.length})
          </button>
          {showTrash ? (
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {trashed.map((folder) => (
                <li key={folder._id}>
                  <div className="group flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-zinc-500">
                    <Trash2 className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                    {canOrganise ? (
                      <button
                        type="button"
                        onClick={() => handleRestore(folder._id)}
                        className="cursor-pointer opacity-0 transition-opacity group-hover:opacity-100"
                        title="Restore"
                      >
                        <RotateCcw className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FolderRow({ folder, depth, collapsed, onToggle, selectedId, onSelect, canOrganise, onTrash }) {
  const hasChildren = Boolean(folder.children?.length);
  const isCollapsed = Boolean(collapsed[folder._id]);
  const active = selectedId === folder._id;

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md py-1.5 pr-2 text-sm transition-colors",
          active ? "bg-blue-50 text-blue-700" : "text-zinc-600 hover:bg-zinc-100"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(folder._id)}
            className="cursor-pointer text-zinc-400 hover:text-zinc-600"
            aria-label={isCollapsed ? "Expand" : "Collapse"}
          >
            {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        ) : (
          <span className="w-3.5" />
        )}

        <button
          type="button"
          onClick={() => onSelect(active ? null : folder._id)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          data-testid={`folder-${folder.name}`}
        >
          <Folder className="size-4 shrink-0" />
          <span className="truncate">{folder.name}</span>
        </button>

        {canOrganise ? (
          <button
            type="button"
            onClick={() => onTrash(folder._id)}
            className="cursor-pointer text-zinc-300 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
            title="Move to trash"
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
      </div>

      {hasChildren && !isCollapsed ? (
        <ul className="flex flex-col gap-0.5">
          {folder.children.map((child) => (
            <FolderRow
              key={child._id}
              folder={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              selectedId={selectedId}
              onSelect={onSelect}
              canOrganise={canOrganise}
              onTrash={onTrash}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}