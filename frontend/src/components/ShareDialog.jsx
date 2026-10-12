"use client";

import { useEffect, useState } from "react";
import { Copy, Globe, Link2, Loader2, Shield, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getShareState,
  LINK_ROLE_OPTIONS,
  getLinkShare,
  removeShare,
  revokeLinkShare,
  sharedLinkUrl,
  updateLinkShare,
  upsertShare,
} from "@/lib/api";

/** Roles the owner can assign, with a human explanation for each. */
const ROLE_OPTIONS = [
  { value: "editor", label: "Can edit", hint: "Edit text, format and comment" },
  { value: "commenter", label: "Can comment", hint: "Read and comment only" },
  { value: "viewer", label: "Can view", hint: "Read only" },
];

/** Human label for a role id. */
function roleLabel(role) {
  return ROLE_OPTIONS.find((r) => r.value === role)?.label || role;
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

/**
 * Sharing dialog.
 *
 * Only the owner sees the manage controls; shared users get a read-only summary
 * of who has access. Every mutation goes through the API and then refetches, so
 * the dialog never holds divergent state.
 */
export default function ShareDialog({ open, onOpenChange, docId, docTitle, isOwner }) {
  const [state, setState] = useState(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // Loading is derived: the data is stale until it matches the current document.
  const loading = !state || state.documentId !== String(docId);

  // Load the access list every time the dialog opens. The fetch runs on a
  // timer tick so the effect body only registers a subscription.
  useEffect(() => {
    if (!open || !docId) return;

    let cancelled = false;
    const kickoff = setTimeout(() => {
      getShareState(docId)
        .then((data) => {
          if (!cancelled) setState(data);
        })
        .catch((err) => {
          if (!cancelled) toast.error(err.message || "Could not load sharing settings");
        });
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(kickoff);
    };
  }, [open, docId]);

  async function addPerson() {
    const value = email.trim();
    if (!value || saving) return;

    setSaving(true);
    try {
      const shares = await upsertShare(docId, value, role);
      setState((s) => ({ ...s, shares }));
      setEmail("");
      toast.success(`Access granted to ${value}`);
    } catch (err) {
      toast.error(err.message || "Could not share document");
    } finally {
      setSaving(false);
    }
  }

  async function changeRole(userId, nextRole) {
    const entry = state?.shares?.find((s) => s.userId === userId);
    if (!entry) return;
    try {
      const shares = await upsertShare(docId, entry.email, nextRole);
      setState((s) => ({ ...s, shares }));
    } catch (err) {
      toast.error(err.message || "Could not change role");
    }
  }

  async function revoke(userId, targetEmail) {
    if (!window.confirm(`Remove access for ${targetEmail}?`)) return;
    try {
      const shares = await removeShare(docId, userId);
      setState((s) => ({ ...s, shares }));
      toast.success("Access removed");
    } catch (err) {
      toast.error(err.message || "Could not remove access");
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Clipboard is not available in this browser");
    }
  }

  /* ---------------------------------------------------------------
   * "Anyone with the link"
   *
   * Separate from the per-person list above because it is a different promise:
   * one capability, no account, and reading only. Turning it off is the only way
   * to be sure a link that was already sent is dead, which is why the revoke
   * asks for confirmation.
   * ---------------------------------------------------------------- */

  const link = state?.link;
  const linkOn = Boolean(link?.enabled);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [expiry, setExpiry] = useState("never");

  async function turnLinkOn() {
    setLinkBusy(true);
    try {
      const next = await updateLinkShare(docId, {
        role: link?.role || "viewer",
        expiresInDays: expiry === "never" ? null : Number(expiry),
      });
      setState((s) => ({ ...s, link: next.link }));
      toast.success("Anyone with the link can now open this document");
    } catch (err) {
      toast.error(err.message || "Could not turn on the link");
    } finally {
      setLinkBusy(false);
    }
  }

  async function changeLinkRole(nextRole) {
    setLinkBusy(true);
    try {
      const next = await updateLinkShare(docId, { role: nextRole });
      setState((s) => ({ ...s, link: next.link }));
    } catch (err) {
      toast.error(err.message || "Could not change what the link allows");
    } finally {
      setLinkBusy(false);
    }
  }

  async function turnLinkOff() {
    if (
      !window.confirm(
        "Turn off the link? Anyone who already has it will lose access. Turning it back on issues a new link."
      )
    ) {
      return;
    }
    setLinkBusy(true);
    try {
      const next = await revokeLinkShare(docId);
      setState((s) => ({ ...s, link: next.link }));
      toast.success("The link has been turned off");
    } catch (err) {
      toast.error(err.message || "Could not turn off the link");
    } finally {
      setLinkBusy(false);
    }
  }

  async function copyPublicLink() {
    try {
      await navigator.clipboard.writeText(sharedLinkUrl(link.url || link.token));
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      toast.error("Clipboard is not available in this browser");
    }
  }

  const shares = state?.shares || [];
  // The access list is only meaningful to the owner, so a non-owner sees who
  // owns the document and how they may participate instead of an empty list.
  const showAccessList = isOwner || shares.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="size-4 text-zinc-500" />
            Share &ldquo;{docTitle}&rdquo;
          </DialogTitle>
          <DialogDescription>
            {isOwner
              ? "Invite people and choose what they can do with this document."
              : "Only the owner can change who has access to this document."}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
            <Loader2 className="size-4 animate-spin" />
            Loading access...
          </div>
        ) : (
          <div className="space-y-4">
            {/* Invite form: owner only */}
            {isOwner ? (
              <div className="flex gap-2">
                <Input
                  value={email}
                  placeholder="Email address"
                  className="flex-1"
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addPerson();
                  }}
                />
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger className="w-[130px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button onClick={addPerson} disabled={saving || !email.trim()}>
                  {saving ? <Loader2 className="animate-spin" /> : <UserPlus />}
                  Invite
                </Button>
              </div>
            ) : null}

            {/* Access list */}
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-zinc-200 p-1">
              {/* Owner row (always present) */}
              {state?.owner ? (
                <AccessRow
                  name={state.owner.name}
                  email={state.owner.email}
                  role="owner"
                  isOwner
                />
              ) : null}

              {shares.map((s) => (
                <AccessRow
                  key={s.userId}
                  name={s.name || s.email}
                  email={s.email}
                  role={s.role}
                  editable={isOwner}
                  onRoleChange={(next) => changeRole(s.userId, next)}
                  onRemove={() => revoke(s.userId, s.email)}
                />
              ))}

              {/* Say nothing rather than implying a shared user is the only one. */}
              {isOwner && !shares.length ? (
                <p className="px-2 py-4 text-center text-xs text-zinc-400">
                  Not shared with anyone yet
                </p>
              ) : null}

              {!showAccessList ? (
                <p className="px-2 py-4 text-center text-xs text-zinc-400">
                  {state?.myRole === "owner" ? "Not shared with anyone yet" : "You are the only person with access"}
                </p>
              ) : null}
            </div>

            {/* "Anyone with the link" -- owner only, because only the owner may
                create one. The reader it creates needs no account at all. */}
            {isOwner ? (
              <div className="space-y-2 rounded-md border border-zinc-200 p-3">
                <div className="flex items-start gap-2">
                  <Globe className="mt-0.5 size-3.5 flex-none text-zinc-400" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-800">
                      Anyone with the link
                    </p>
                    <p className="text-[11px] text-zinc-500">
                      {linkOn
                        ? "No account needed. Anyone who has the link can open this document."
                        : "Off. Nobody can open this document without an account."}
                    </p>
                  </div>
                </div>

                {linkOn ? (
                  <>
                    <div className="flex items-center gap-2 rounded bg-zinc-50 px-2.5 py-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-600">
                        {sharedLinkUrl(link.url || link.token)}
                      </span>
                      <Button variant="outline" size="sm" onClick={copyPublicLink}>
                        <Copy />
                        {linkCopied ? "Copied" : "Copy"}
                      </Button>
                    </div>

                    <div className="flex items-center gap-2">
                      <Select
                        value={link.role}
                        onValueChange={changeLinkRole}
                        disabled={linkBusy}
                      >
                        <SelectTrigger className="h-7 w-[140px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LINK_ROLE_OPTIONS.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={turnLinkOff}
                        disabled={linkBusy}
                        className="ml-auto text-zinc-500 hover:text-red-600"
                      >
                        Turn off
                      </Button>
                    </div>

                    {link.expiresAt ? (
                      <p className="text-[11px] text-zinc-500">
                        Expires {new Date(link.expiresAt).toLocaleDateString()}.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <Select value={expiry} onValueChange={setExpiry}>
                      <SelectTrigger className="h-7 w-[140px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="never">Never expires</SelectItem>
                        <SelectItem value="1">1 day</SelectItem>
                        <SelectItem value="7">7 days</SelectItem>
                        <SelectItem value="30">30 days</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button size="sm" onClick={turnLinkOn} disabled={linkBusy} className="ml-auto">
                      {linkBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Globe />}
                      Turn on
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              /* Non-owners still get the editor link, which is the ordinary
                 signed-in link rather than the public one. */
              <div className="flex items-center gap-2 rounded-md bg-zinc-50 px-3 py-2">
                <Link2 className="size-3.5 flex-none text-zinc-400" />
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">
                  Only the owner can turn on the public link.
                </span>
                <Button variant="outline" size="sm" onClick={copyLink}>
                  <Copy />
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One row of the access list. */
function AccessRow({ name, email, role, isOwner, editable, onRoleChange, onRemove }) {
  return (
    <div className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-50">
      <span className="flex size-7 flex-none items-center justify-center rounded-full bg-zinc-800 text-[10px] font-semibold text-white">
        {initials(name)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-zinc-800">
          {name}
          {isOwner ? (
            <span className="ml-1.5 text-[10px] uppercase tracking-wide text-zinc-400">owner</span>
          ) : null}
        </span>
        <span className="block truncate text-[11px] text-zinc-500">{email}</span>
      </span>

      {editable ? (
        <>
          <Select value={role} onValueChange={onRoleChange}>
            <SelectTrigger className="h-7 w-[124px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            aria-label={`Remove ${email}`}
            className="text-zinc-400 hover:text-red-500"
          >
            <Trash2 />
          </Button>
        </>
      ) : (
        <span className="rounded bg-zinc-100 px-2 py-1 text-[11px] text-zinc-600">
          {roleLabel(role)}
        </span>
      )}
    </div>
  );
}
