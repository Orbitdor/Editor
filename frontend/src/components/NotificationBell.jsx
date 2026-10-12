"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getNotifications, markNotificationsRead } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Poll interval for the unread badge, in milliseconds. */
const POLL_MS = 30_000;

/** Icon-free label per notification type. */
const TYPE_LABEL = {
  mention: "Mention",
  comment: "Comment",
  share: "Shared with you",
  resolve: "Resolved",
};

function timeAgo(value) {
  if (!value) return "";
  const mins = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString();
}

/**
 * Header notification bell.
 *
 * Polls the API on an interval rather than holding a socket open: notifications
 * are not latency-critical, and this keeps one WebSocket per editor tab instead
 * of two. The dropdown closes on an outside click.
 */
export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getNotifications(20);
      setItems(data.items || []);
      setUnread(data.unread || 0);
    } catch {
      // Silent: a failed poll should not disturb editing.
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + polling. `loading` is what the empty state reads, so the
  // effect only needs to register the timer.
  useEffect(() => {
    const kickoff = setTimeout(load, 0);
    const timer = setInterval(load, POLL_MS);
    return () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    };
  }, [load]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (!ref.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function openPanel() {
    setOpen((v) => !v);
    // Opening the panel is an implicit acknowledgement of what is on screen.
    if (!open && unread > 0) {
      try {
        await markNotificationsRead();
        setUnread(0);
        setItems((list) => list.map((n) => ({ ...n, read: true })));
      } catch {
        // ignore
      }
    }
  }

  function goTo(item) {
    setOpen(false);
    if (item.documentId) router.push(`/editor/${item.documentId}`);
  }

  async function markAll() {
    try {
      await markNotificationsRead();
      setUnread(0);
      setItems((list) => list.map((n) => ({ ...n, read: true })));
    } catch {
      // ignore
    }
  }

  return (
    <div ref={ref} className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={openPanel}
        className="relative"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
      >
        <Bell />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </Button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-zinc-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
            <span className="text-sm font-semibold text-zinc-800">Notifications</span>
            {items.length ? (
              <button
                type="button"
                onClick={markAll}
                className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700"
              >
                <CheckCheck className="size-3" />
                Mark all read
              </button>
            ) : null}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {loading && !items.length ? (
              <p className="py-6 text-center text-xs text-zinc-400">Loading...</p>
            ) : items.length === 0 ? (
              <p className="py-8 text-center text-xs text-zinc-400">No notifications</p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => goTo(n)}
                  className={cn(
                    "flex w-full gap-2 border-b border-zinc-50 px-3 py-2 text-left transition-colors last:border-0 hover:bg-zinc-50",
                    !n.read && "bg-blue-50/40"
                  )}
                >
                  <span
                    className={cn(
                      "mt-1 size-1.5 flex-none rounded-full",
                      n.read ? "bg-transparent" : "bg-blue-500"
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                      {TYPE_LABEL[n.type] || n.type}
                    </span>
                    <span className="block truncate text-xs text-zinc-700">
                      {n.actor?.name ? `${n.actor.name}: ` : ""}
                      {n.text}
                    </span>
                    <span className="block text-[10px] text-zinc-400">{timeAgo(n.createdAt)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
