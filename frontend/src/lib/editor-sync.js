import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { prosemirrorJSONToYXmlFragment, prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import { DOMParser as ProseDOMParser } from "@tiptap/pm/model";
import { WS_BASE } from "./ws-base.js";

export const CURSOR_COLORS = [
  "#958DF1",
  "#F98181",
  "#FBBC88",
  "#FAF594",
  "#70CFF8",
  "#94FAD1",
  "#B9F18D",
  "#C3E2C2",
  "#EAECCC",
  "#FCCFE9",
];

const entries = new Map();

function pickColor(user) {
  const key = String(user?.id || user?.email || user?.name || "guest");
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

export function collabUserInfo(user) {
  return {
    name: user?.name || user?.email || "Guest",
    color: pickColor(user),
    email: user?.email || "",
  };
}

function attachStatus(entry) {
  if (!entry.provider || entry.statusAttached) return;
  entry.statusAttached = true;
  entry.statusCbs = [];
  const forward = (status) => {
    entry.status = status;
    entry.statusCbs.forEach((cb) => cb(status));
  };
  entry.provider.on("status", (e) => forward(e.status));
  entry.provider.on("connection-error", () => forward("disconnected"));
}

export function createCollab({ docId, user }) {
  const cached = entries.get(docId);
  if (cached) return cached;

  const ydoc = new Y.Doc();
  const entry = { ydoc, provider: null, seeded: false, status: "offline", revive: false };

  if (typeof window !== "undefined" && WS_BASE) {
    // No token in the URL: the handshake carries the HttpOnly session cookie,
    // so a collaborator token never reaches a proxy or server access log.
    const provider = new WebsocketProvider(WS_BASE, docId, ydoc, { connect: true });
    provider.awareness.setLocalStateField("user", {
      name: user?.name || user?.email || "Guest",
      color: pickColor(user),
      email: user?.email || "",
    });
    entry.provider = provider;
    attachStatus(entry);
  }

  entries.set(docId, entry);
  return entry;
}

export function destroyCollab(docId) {
  const entry = entries.get(docId);
  if (!entry) return;
  entry.revive = false;
  setTimeout(() => {
    const cur = entries.get(docId);
    if (cur && cur !== entry) return;
    if (entry.revive) {
      entry.revive = false;
      return;
    }
    entries.delete(docId);
    if (entry.provider) {
      try {
        entry.provider.destroy();
      } catch {
        /* noop */
      }
    }
    try {
      entry.ydoc.destroy();
    } catch {
      /* noop */
    }
  }, 0);
}

export function reviveCollab(docId) {
  const entry = entries.get(docId);
  if (entry) entry.revive = true;
}

export function seedCollab(entry, editor, source) {
  if (entry.seeded || !editor?.schema) return false;
  const frag = entry.ydoc.getXmlFragment("default");
  if (frag.length > 0) {
    entry.seeded = true;
    return false;
  }
  if (typeof window === "undefined") return false;

  try {
    const json = source?.contentJson ?? null;
    if (json && json.content) {
      prosemirrorJSONToYXmlFragment(editor.schema, json, frag);
      entry.seeded = true;
      return true;
    }
    const html = source?.content;
    if (html) {
      const dom = new window.DOMParser().parseFromString(html, "text/html");
      const pmDoc = ProseDOMParser.fromSchema(editor.schema).parse(dom);
      prosemirrorToYXmlFragment(pmDoc, frag);
      entry.seeded = true;
      return true;
    }
  } catch (err) {
    console.error("[collab] seed failed:", err);
  }
  return false;
}

export function subscribeCollabUsers(entry, cb) {
  if (!entry.provider) return () => {};
  const awareness = entry.provider.awareness;
  const emit = () => {
    const users = [];
    awareness.getStates().forEach((state, clientId) => {
      const u = state?.user;
      if (!u) return;
      users.push({
        name: u.name || u.email || "Guest",
        color: u.color || CURSOR_COLORS[0],
        email: u.email || "",
        self: clientId === awareness.clientID,
      });
    });
    cb(users);
  };
  awareness.on("change", emit);
  emit();
  return () => awareness.off("change", emit);
}

export function subscribeCollabStatus(entry, cb) {
  if (!entry.provider) return () => {};
  attachStatus(entry);
  entry.statusCbs.push(cb);
  cb(entry.status);
  return () => {
    const i = entry.statusCbs.indexOf(cb);
    if (i >= 0) entry.statusCbs.splice(i, 1);
  };
}

export function onCollabSync(entry, cb) {
  if (!entry.provider) return () => {};
  return entry.provider.on("sync", cb);
}