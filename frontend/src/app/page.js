"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  LogOut,
  Plus,
  FileText,
  Star,
  Trash2,
  RotateCcw,
  FolderOpen,
  Search,
} from "lucide-react";

import { getDocs, createDoc, trashDoc, restoreDoc, starDoc } from "@/lib/api";
import { getToken, getUser, clearSession } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  { key: "trash", label: "Trash", icon: Trash2 },
];

export default function Dashboard() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState("all");
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    return getDocs({
      scope: scope === "all" ? undefined : scope,
      q: query || undefined,
    });
  }, [scope, query]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setMe(getUser()));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }

    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      setLoading(true);
      load()
        .then((data) => {
          if (!cancelled) setDocs(data);
        })
        .catch((err) => {
          console.error(err);
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

  async function handleNewDoc() {
    try {
      const doc = await createDoc();
      router.push(`/editor/${doc._id}`);
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not create document");
    }
  }

  function handleLogout() {
    clearSession();
    router.push("/login");
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
                onClick={() => setScope(item.key)}
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
        </nav>
      </aside>

      <main className="min-w-0 flex-1">
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
            <label className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search documents..."
                className="h-9 w-44 rounded-md border border-zinc-200 bg-white pl-8 pr-3 text-sm outline-none focus:border-blue-400"
              />
            </label>
            <Button variant="outline" onClick={handleLogout} data-testid="logout">
              <LogOut />
              <span className="hidden sm:inline">Log out</span>
            </Button>
            <Button onClick={handleNewDoc}>
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
                : query
                  ? "No documents match your search."
                  : "No documents yet. Click \"New document\" to create one."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {docs.map((doc) => {
              const preview = excerpt(doc) || "Empty document";
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
                  </div>
                  <p className="line-clamp-3 whitespace-pre-wrap text-sm text-zinc-500">
                    {preview}
                  </p>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-xs text-zinc-400">
                      Edited {timeAgo(doc.updatedAt)}
                    </span>
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
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}