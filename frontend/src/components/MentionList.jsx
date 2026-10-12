"use client";

import { useImperativeHandle, useRef, useState, forwardRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Suggestion list for the @mention extension.
 *
 * Tiptap's suggestion plugin drives this component imperatively: it forwards
 * keyboard events here and reads the resolved item back through the ref.
 */
const MentionList = forwardRef(function MentionList({ items, command, query }, ref) {
  // Highlight the first candidate. Clamping instead of resetting in an effect
  // keeps the component free of cascading renders.
  const [selected, setSelected] = useState(0);
  const active = items.length ? Math.min(selected, items.length - 1) : 0;
  const listRef = useRef(null);

  // Expose the keyboard + selection API that @tiptap/suggestion expects.
  useImperativeHandle(ref, () => ({
    onKeyDown({ event }) {
      if (event.key === "ArrowUp") {
        setSelected((i) => (i + items.length - 1) % items.length);
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelected((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === "Enter") {
        const item = items[Math.min(selected, items.length - 1)];
        if (item) command(item);
        return true;
      }
      if (event.key === "Escape") {
        return true;
      }
      return false;
    },
  }));

  if (!items.length) {
    return (
      <div className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-500 shadow-md">
        No users found{query ? ` for "${query}"` : ""}
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="max-h-64 w-64 overflow-y-auto rounded-md border border-zinc-200 bg-white p-1 shadow-lg"
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          // Prevent the editor from losing focus when a row is clicked.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => command(item)}
          className={cn(
            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
            i === active ? "bg-zinc-100" : "hover:bg-zinc-50"
          )}
        >
          <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-zinc-800 text-[10px] font-semibold text-white">
            {item.name?.slice(0, 1).toUpperCase() || "?"}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-zinc-800">{item.name}</span>
            <span className="block truncate text-[11px] text-zinc-500">{item.email}</span>
          </span>
        </button>
      ))}
    </div>
  );
});

/**
 * Position the mention popup near the caret using the client rect the
 * suggestion plugin provides. Rendered through a portal so it escapes the
 * editor's overflow and stacking context.
 */
export function MentionPopup({ rect, items, command, query }) {
  if (typeof document === "undefined") return null;

  const style = rect
    ? {
        position: "fixed",
        top: `${rect.bottom + 6}px`,
        left: `${Math.min(rect.left, window.innerWidth - 272)}px`,
        zIndex: 9999,
      }
    : { position: "fixed", top: "80px", left: "80px", zIndex: 9999 };

  return createPortal(
    <div style={style}>
      <MentionList items={items} command={command} query={query} />
    </div>,
    document.body
  );
}

export default MentionList;
