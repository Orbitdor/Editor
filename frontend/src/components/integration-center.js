"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  FileText,
  Loader2,
  Plug,
  PlugZap,
  Search,
  Unplug,
  Upload,
  X,
} from "lucide-react";

import {
  disconnectGoogle,
  exportToGoogleDrive,
  getGoogleStatus,
  importGoogleFile,
  listGoogleFiles,
  startGoogleConnect,
} from "@/lib/api";
import { Button } from "@/components/ui/button";

/**
 * Google Integration Center (master plan sections 29-31).
 *
 * One place that answers three questions: what can Google do for this account,
 * which permissions are already granted, and how to move a document in or out.
 * Connect and disconnect are the only destructive actions, and both ask first.
 *
 * Drive/Docs/Speech/Vision are separate permission groups on purpose. Connecting
 * a Drive must never silently grant audio or image access, so each is a separate
 * checkbox and the consent screen only ever asks for what is ticked.
 */
const GROUPS = [
  { id: "drive", label: "Drive", hint: "Browse and import your files" },
  { id: "docs", label: "Google Docs", hint: "Import with formatting kept" },
  { id: "speech", label: "Speech-to-Text", hint: "Dictation billed to your project" },
  { id: "vision", label: "Cloud Vision", hint: "Scan text in images" },
];

export function IntegrationCenter({ open, onClose, document: doc, onImported }) {
  // The parent mounts this only while the dialog is open, so a fresh open starts
  // in the loading state without the effect having to set it.
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [selected, setSelected] = useState([]);
  const [files, setFiles] = useState([]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [exporting, setExporting] = useState(false);

  const connection = status?.connection;
  const connected = Boolean(connection?.connected);

  /** Reload after a mutation. Only called from event handlers. */
  const refresh = useCallback(async () => {
    try {
      const data = await getGoogleStatus();
      setStatus(data);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on open. The state update lands in a promise callback rather than in the
  // effect body, so the dialog appears immediately and fills in when the answer
  // arrives.
  useEffect(() => {
    if (!open) return;
    let alive = true;

    getGoogleStatus()
      .then((data) => {
        if (alive) setStatus(data);
      })
      .catch((err) => {
        if (alive) toast.error(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [open]);

  async function handleConnect() {
    if (!selected.length) {
      toast.error("Pick at least one permission.");
      return;
    }
    setBusy("connect");
    try {
      const { url, mock } = await startGoogleConnect(selected);
      if (mock) {
        toast.info("Google Drive needs server credentials.", {
          description: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to switch it on.",
        });
        return;
      }
      // A full navigation, since Google owns the consent step.
      window.location.assign(url);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy("");
    }
  }

  async function handleDisconnect() {
    if (!window.confirm("Disconnect Google? Drive, Docs, speech and vision access will stop working.")) return;
    setBusy("disconnect");
    try {
      await disconnectGoogle();
      setSelected([]);
      setFiles([]);
      toast.success("Google disconnected");
      await refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy("");
    }
  }

  async function searchFiles(e) {
    e?.preventDefault();
    setSearching(true);
    try {
      const data = await listGoogleFiles({ q: query });
      setFiles(data.files || []);
      if (data.mock) {
        toast.info("Showing sample Drive files", { description: "Connect real credentials for live files." });
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSearching(false);
    }
  }

  async function handleImport(file) {
    setBusy(file.id);
    try {
      const data = await importGoogleFile(file.id);
      toast.success(`Imported ${data.title}`, {
        description: data.limitations?.length
          ? `Some formatting was simplified (${data.limitations.length} item${data.limitations.length > 1 ? "s" : ""})`
          : undefined,
      });
      onImported?.(data);
      onClose?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy("");
    }
  }

  async function handleExport() {
    if (!doc) return;
    setExporting(true);
    try {
      const html = typeof doc.getHTML === "function" ? doc.getHTML() : "";
      const data = await exportToGoogleDrive(doc.title || "Untitled", html);
      toast.success("Saved to Google Drive");
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setExporting(false);
    }
  }

  function toggle(id) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));
  }

  if (!open) return null;

  const hasFileGroup = selected.includes("drive") || selected.includes("docs");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-zinc-900">
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div>
            <h2 className="text-sm font-semibold">Google integrations</h2>
            <p className="text-xs text-zinc-500">
              {connected ? connection.email || "Connected" : "Not connected"}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking connection...
            </div>
          ) : (
            <>
              {!status?.configured && (
                <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                  This server has no Google credentials configured, so these controls run against sample
                  data. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for live access.
                </p>
              )}

              <ul className="flex flex-col gap-2">
                {GROUPS.map((group) => {
                  const granted = connection?.groups?.includes(group.id);
                  return (
                    <li key={group.id} className="flex items-center gap-3 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
                      <input
                        id={`google-group-${group.id}`}
                        type="checkbox"
                        checked={selected.includes(group.id)}
                        onChange={() => toggle(group.id)}
                        disabled={granted}
                        className="h-4 w-4"
                      />
                      <label htmlFor={`google-group-${group.id}`} className="flex-1 text-sm">
                        <span className="font-medium">{group.label}</span>
                        <span className="block text-xs text-zinc-500">{group.hint}</span>
                      </label>
                      {granted && (
                        <span className="flex items-center gap-1 text-xs text-emerald-600">
                          <Check className="h-3 w-3" /> On
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>

              <div className="mt-4 flex flex-wrap gap-2">
                {connected ? (
                  <Button type="button" onClick={handleDisconnect} disabled={busy === "disconnect"} variant="outline" size="sm">
                    {busy === "disconnect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
                    Disconnect
                  </Button>
                ) : (
                  <Button type="button" onClick={handleConnect} disabled={busy === "connect" || !hasFileGroup} size="sm">
                    {busy === "connect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                    Connect
                  </Button>
                )}
                {doc && (
                  <Button type="button" onClick={handleExport} disabled={exporting || !connected} variant="outline" size="sm">
                    {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    Export to Drive
                  </Button>
                )}
              </div>

              {connected && (
                <section className="mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                  <h3 className="mb-2 text-sm font-medium">Import from Drive</h3>
                  <form onSubmit={searchFiles} className="mb-3 flex gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-2 top-2.5 h-4 w-4 text-zinc-400" />
                      <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search files"
                        className="w-full rounded-md border border-zinc-300 py-2 pl-8 pr-2 text-sm dark:border-zinc-700 dark:bg-zinc-800"
                      />
                    </div>
                    <Button type="submit" size="sm" variant="secondary" disabled={searching}>
                      {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Search
                    </Button>
                  </form>

                  {files.length === 0 ? (
                    <p className="text-xs text-zinc-500">Search to list your Google Docs.</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {files.map((file) => (
                        <li key={file.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800">
                          <FileText className="h-4 w-4 shrink-0 text-zinc-400" />
                          <span className="flex-1 truncate text-sm">{file.name}</span>
                          {file.importable ? (
                            <Button type="button" size="sm" variant="ghost" disabled={busy === file.id} onClick={() => handleImport(file)}>
                              {busy === file.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                              Import
                            </Button>
                          ) : (
                            <span className="text-xs text-zinc-400">not a Doc</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default IntegrationCenter;

/** Small trigger for the editor toolbar. */
export function IntegrationCenterButton({ onClick }) {
  return (
    <Button type="button" onClick={onClick} variant="outline" size="sm" title="Google integrations">
      <PlugZap className="h-4 w-4" />
      Google
    </Button>
  );
}