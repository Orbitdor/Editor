"use client";

import { useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  MessageSquare,
  Pencil,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Deterministic avatar colour so the same person always looks the same. */
const AVATAR_COLORS = [
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#ea580c",
  "#16a34a",
  "#0891b2",
  "#4f46e5",
  "#b45309",
];

function avatarColor(seed) {
  const key = String(seed || "?");
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

function timeAgo(value) {
  if (!value) return "";
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString();
}

/**
 * Resolve the plain text of a comment body for display.
 *
 * The editor writes mentions as `@[Name](id)`; strip the markup so the text
 * reads naturally while still being recognisable as a mention.
 */
function renderBody(body) {
  return String(body || "").replace(/@\[[^\]]*\]\([a-f\d]{24}\)/gi, (m) => {
    const name = /@\[([^\]]*)\]/.exec(m)?.[1];
    return name ? `@${name}` : m;
  });
}

/**
 * Right-hand comments panel.
 *
 * Comments are server-authoritative: this component only renders what the API
 * returns and calls the API on user actions. Anchors are best-effort, so a
 * thread whose highlight drifted is still reachable from this list.
 *
 * The focused thread lives in the parent, not here, so clicking a highlight in
 * the document and picking a thread in this list stay in agreement.
 */
export default function CommentsPanel({
  onClose,
  threads,
  loading,
  currentUserId,
  canComment,
  canDelete,
  activeId,
  onSelect,
  onReply,
  onEdit,
  onResolve,
  onDelete,
}) {
  const [filter, setFilter] = useState("open"); // "open" | "resolved" | "all"
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);

  const visible = useMemo(() => {
    if (filter === "all") return threads;
    return threads.filter((t) => (filter === "resolved" ? t.resolved : !t.resolved));
  }, [threads, filter]);

  const openCount = threads.filter((t) => !t.resolved).length;
  const resolvedCount = threads.filter((t) => t.resolved).length;

  const counts = { open: openCount, resolved: resolvedCount, all: threads.length };

  async function submitReply(threadId) {
    const text = (drafts[threadId] || "").trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onReply(threadId, text);
      setDrafts((d) => ({ ...d, [threadId]: "" }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="no-print flex h-full w-80 flex-none flex-col border-l border-zinc-200 bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <MessageSquare className="size-4 text-zinc-500" />
          <span className="text-sm font-semibold text-zinc-800">Comments</span>
          {openCount > 0 ? (
            <span className="rounded-full bg-blue-50 px-1.5 text-[10px] font-semibold text-blue-600">
              {openCount}
            </span>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close comments">
          <X />
        </Button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-zinc-100 px-2 py-1.5">
        {["open", "resolved", "all"].map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={cn(
              "rounded px-2 py-1 text-xs font-medium capitalize transition-colors",
              filter === key ? "bg-zinc-100 text-zinc-900" : "text-zinc-500 hover:bg-zinc-50"
            )}
          >
            {key} ({counts[key]})
          </button>
        ))}
      </div>

      {/* Thread list */}
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-2">
        {loading ? (
          <p className="py-6 text-center text-xs text-zinc-400">Loading comments...</p>
        ) : visible.length === 0 ? (
          <div className="py-10 text-center">
            <MessageSquare className="mx-auto mb-2 size-6 text-zinc-300" />
            <p className="text-xs text-zinc-500">
              {filter === "resolved" ? "No resolved threads" : "No comments yet"}
            </p>
            <p className="mt-1 text-[11px] text-zinc-400">
              {canComment
                ? "Select text and press the comment button."
                : "You have read-only access."}
            </p>
          </div>
        ) : (
          visible.map((thread) => {
            const isActive = activeId === thread.id;
            return (
              <article
                key={thread.id}
                data-thread-id={thread.id}
                onClick={() => onSelect?.(isActive ? null : thread)}
                className={cn(
                  "cursor-pointer rounded-lg border p-2.5 transition-colors",
                  isActive
                    ? "border-blue-300 bg-blue-50/40"
                    : "border-zinc-200 bg-white hover:border-zinc-300"
                )}
              >
                {/* Quoted anchor text */}
                {thread.quotedText ? (
                  <blockquote className="mb-1.5 line-clamp-2 border-l-2 border-amber-300 bg-amber-50/60 pl-2 text-[11px] italic text-zinc-500">
                    {thread.quotedText}
                  </blockquote>
                ) : null}

                {/* Root comment */}
                <CommentBody
                  comment={thread}
                  currentUserId={currentUserId}
                  canComment={canComment}
                  onEdit={onEdit}
                />

                {/* Thread actions */}
                <div className="mt-1.5 flex items-center gap-1 text-[10px] text-zinc-400">
                  <button
                    type="button"
                    disabled={!canComment}
                    onClick={(e) => {
                      e.stopPropagation();
                      onResolve?.(thread, !thread.resolved);
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-40"
                    title={thread.resolved ? "Reopen thread" : "Resolve thread"}
                  >
                    {thread.resolved ? <Check className="size-3" /> : <CheckCheck className="size-3" />}
                    {thread.resolved ? "Reopen" : "Resolve"}
                  </button>
                  {(currentUserId === thread.author?.id || canDelete) && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete?.(thread);
                      }}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-red-50 hover:text-red-500"
                      title="Delete thread"
                    >
                      <Trash2 className="size-3" />
                      Delete
                    </button>
                  )}
                  {thread.resolved ? (
                    <span className="ml-auto inline-flex items-center gap-1 text-emerald-600">
                      <CheckCheck className="size-3" /> Resolved
                    </span>
                  ) : null}
                </div>

                {/* Replies */}
                {thread.replies?.length ? (
                  <div className="mt-2 space-y-2 border-l-2 border-zinc-100 pl-2">
                    {thread.replies.map((reply) => (
                      <CommentBody
                        key={reply.id}
                        comment={reply}
                        currentUserId={currentUserId}
                        canComment={canComment}
                        onEdit={onEdit}
                      />
                    ))}
                  </div>
                ) : null}

                {/* Reply box */}
                {isActive && canComment && !thread.resolved ? (
                  <div
                    className="mt-2 flex gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Input
                      autoFocus
                      value={drafts[thread.id] || ""}
                      placeholder="Reply..."
                      className="h-7 text-xs"
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [thread.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          submitReply(thread.id);
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      className="h-7 px-2"
                      disabled={busy || !(drafts[thread.id] || "").trim()}
                      onClick={() => submitReply(thread.id)}
                      aria-label="Send reply"
                    >
                      <Send className="size-3.5" />
                    </Button>
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </aside>
  );
}

/** A single comment: avatar, author, timestamp, body, edit/delete for own comments. */
function CommentBody({ comment, currentUserId, canComment, onEdit }) {
  const [editing, setEditing] = useState(false);
  // The draft follows the server value unless the user is actively editing.
  // Keying the whole panel by document id (see the page) resets it instead.
  const [text, setText] = useState(comment.body);
  const [busy, setBusy] = useState(false);

  async function saveEdit() {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onEdit?.(comment.id, value);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex gap-2">
      <span
        className="flex size-6 flex-none items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{ backgroundColor: avatarColor(comment.author?.email || comment.author?.id) }}
      >
        {initials(comment.author?.name)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-semibold text-zinc-800">
            {comment.author?.name || "Unknown"}
          </span>
          {comment.author?.id === currentUserId ? (
            <span className="text-[9px] uppercase tracking-wide text-zinc-400">you</span>
          ) : null}
          <span className="text-[10px] text-zinc-400">{timeAgo(comment.createdAt)}</span>
          {comment.editedAt ? (
            <span className="text-[9px] text-zinc-300">edited</span>
          ) : null}
        </div>

        {editing ? (
          <div className="mt-1 space-y-1">
            <Input
              autoFocus
              value={text}
              className="h-7 text-xs"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                }
                if (e.key === "Escape") setEditing(false);
              }}
            />
            <div className="flex gap-1">
              <Button size="sm" className="h-6 px-2 text-[10px]" disabled={busy} onClick={saveEdit}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={() => {
                  setText(comment.body);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-700">
            {renderBody(comment.body)}
          </p>
        )}

        {comment.author?.id === currentUserId && canComment && !editing ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
            className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] text-zinc-400 hover:text-zinc-600"
          >
            <Pencil className="size-2.5" /> Edit
          </button>
        ) : null}
      </div>
    </div>
  );
}
