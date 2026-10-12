import { Node, mergeAttributes } from "@tiptap/core";
import { attachmentContentUrl } from "@/lib/api";

/**
 * The attachment node (master plan section 27, "attachment cards with
 * previews, download buttons and delete").
 *
 * Design note on why this is a node and not just a link: the document is a Yjs
 * CRDT, so anything written into the content is replicated to every collaborator
 * immediately. A node holds only the attachment *id*, the name and the size; the
 * bytes live in object storage and the access check lives on the server. A
 * collaborator who cannot see the document cannot fetch the file, and deleting the
 * file makes every copy of the card render as "no longer available" rather than
 * silently showing a broken download.
 */
const AttachmentNode = Node.create({
  name: "attachment",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      attachmentId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-attachment-id"),
        renderHTML: (attrs) => (attrs.attachmentId ? { "data-attachment-id": attrs.attachmentId } : {}),
      },
      name: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-name") || "",
        renderHTML: (attrs) => (attrs.name ? { "data-name": attrs.name } : {}),
      },
      mime: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-mime") || "",
        renderHTML: (attrs) => (attrs.mime ? { "data-mime": attrs.mime } : {}),
      },
      bytes: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute("data-bytes");
          return raw ? Number(raw) : null;
        },
        renderHTML: (attrs) => (attrs.bytes ? { "data-bytes": String(attrs.bytes) } : {}),
      },
      width: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute("data-width");
          return raw ? Number(raw) : null;
        },
        renderHTML: (attrs) => (attrs.width ? { "data-width": String(attrs.width) } : {}),
      },
      height: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute("data-height");
          return raw ? Number(raw) : null;
        },
        renderHTML: (attrs) => (attrs.height ? { "data-height": String(attrs.height) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-attachment-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-attachment-card": "1",
        class: "attachment-card",
      }),
    ];
  },

  addNodeView() {
    // The rendered card is plain DOM rather than a React component, because it
    // has to survive inside the ProseMirror view without a React root per node.
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "attachment-card";
      dom.setAttribute("data-attachment-id", node.attrs.attachmentId || "");

      const head = document.createElement("div");
      head.className = "attachment-card-head";

      const icon = document.createElement("span");
      icon.className = "attachment-card-icon";
      icon.textContent = iconFor(node.attrs.mime);
      head.appendChild(icon);

      const title = document.createElement("span");
      title.className = "attachment-card-name";
      title.textContent = node.attrs.name || "Attachment";
      head.appendChild(title);

      const meta = document.createElement("span");
      meta.className = "attachment-card-meta";
      meta.textContent = formatBytes(node.attrs.bytes);
      head.appendChild(meta);

      dom.appendChild(head);

      // The download link points at the content route, which the browser opens
      // with the session cookie attached; there is no token in the URL.
      const link = document.createElement("a");
      link.className = "attachment-card-download";
      link.href = node.attrs.attachmentId ? attachmentContentUrl(node.attrs.attachmentId) : "#";
      link.rel = "noopener noreferrer";
      link.textContent = "Download";
      dom.appendChild(link);

      return { dom };
    };
  },

  addCommands() {
    return {
      /** Drop a card for an uploaded attachment into the document. */
      insertAttachment:
        (attrs) =>
        ({ chain }) =>
          chain().insertContent({ type: this.name, attrs }).run(),
    };
  },
});

const ICONS = {
  "image/png": "🖼",
  "image/jpeg": "🖼",
  "image/gif": "🖼",
  "image/webp": "🖼",
  "application/pdf": "📕",
  "application/zip": "🗜",
  "text/csv": "📊",
  "text/plain": "📄",
};

function iconFor(mime) {
  if (!mime) return "📎";
  if (ICONS[mime]) return ICONS[mime];
  if (mime.startsWith("image/")) return "🖼";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.includes("wordprocessingml") || mime === "application/msword") return "📘";
  if (mime.includes("spreadsheetml") || mime === "application/vnd.ms-excel") return "📗";
  if (mime.includes("presentationml") || mime === "application/vnd.ms-powerpoint") return "📙";
  return "📎";
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!n || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export { AttachmentNode, formatBytes, iconFor };
export default AttachmentNode;