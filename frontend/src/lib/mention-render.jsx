"use client";

import { createRef } from "react";
import { createRoot } from "react-dom/client";
import MentionList from "@/components/MentionList";
import { searchMentionUsers } from "@/lib/api";

/** Popup width in pixels, used to keep it inside the viewport. */
const POPUP_WIDTH = 264;

/**
 * A single renderer instance is shared by the whole app: the mention popup is
 * global UI, and only one editor page is mounted at a time. Keeping it at
 * module scope also avoids creating it during React render.
 *
 * @type {object|null}
 */
let sharedRenderer = null;

/** Get (and lazily create) the app-wide mention renderer. */
export function getMentionRenderer() {
  if (!sharedRenderer) sharedRenderer = buildRenderer();
  return sharedRenderer;
}

/**
 * Build the render object that @tiptap/suggestion needs for @mentions.
 *
 * The plugin calls `onStart` / `onUpdate` / `onKeyDown` / `onExit` and expects a
 * DOM element back. We mount a small React root into a detached container and
 * position it next to the caret, which avoids pulling in a positioning library.
 *
 * @returns {object} suggestion render handlers
 */
function buildRenderer() {
  let root = null;
  let container = null;
  let current = null;
  let lastQuery = null;

  /**
   * Ref handed to <MentionList> so `onKeyDown` can drive the selection.
   * `createRef` is used instead of `useRef` because this code runs outside React.
   */
  let listRef = createRef(null);

  /** Monotonic token: a slow search must not paint after the popup closed. */
  let requestId = 0;

  function destroy() {
    // Invalidate any in-flight lookup.
    requestId += 1;
    if (root) {
      const r = root;
      root = null;
      // Unmount on a microtask: React forbids unmounting during a render.
      queueMicrotask(() => r.unmount());
    }
    if (container) {
      container.remove();
      container = null;
    }
    listRef = createRef(null);
    current = null;
    lastQuery = null;
  }

  /** Fetch candidates for the text typed after "@". */
  async function load(query) {
    const token = ++requestId;
    try {
      const users = await searchMentionUsers(query);
      if (token !== requestId || !root) return; // stale or closed
      current = { ...current, users };
      paint();
    } catch {
      // A failed lookup must never block typing; keep the popup with no results.
    }
  }

  function paint() {
    if (!root) return;

    const rect = current?.clientRect;
    const style = rect
      ? {
          position: "fixed",
          top: `${rect.bottom + 6}px`,
          left: `${Math.max(8, Math.min(rect.left, window.innerWidth - POPUP_WIDTH))}px`,
          width: `${POPUP_WIDTH}px`,
          zIndex: 9999,
        }
      : { position: "fixed", top: "80px", left: "80px", width: `${POPUP_WIDTH}px`, zIndex: 9999 };

    root.render(
      <div style={style}>
        <MentionList
          ref={listRef}
          items={current?.users || []}
          query={current?.query || ""}
          command={(item) => current?.command?.(item)}
        />
      </div>
    );
  }

  return {
    onStart(props) {
      container = document.createElement("div");
      container.className = "mention-popup-host";
      document.body.appendChild(container);
      root = createRoot(container);
      listRef = createRef(null);
      current = { ...props, users: [] };
      lastQuery = props.query;
      paint();
      load(props.query);
    },

    onUpdate(props) {
      if (!current) return;
      current = { ...current, ...props, users: current.users || [] };
      // Only refetch when the query text actually changed.
      if (props.query !== lastQuery) {
        lastQuery = props.query;
        load(props.query);
      }
      paint();
    },

    onKeyDown(props) {
      if (props.event.key === "Escape") {
        destroy();
        return true;
      }
      // Arrow keys / Enter / Tab are handled by the list itself.
      return listRef.current?.onKeyDown?.(props) ?? false;
    },

    onExit() {
      destroy();
    },
  };
}
