import { Node, Extension, Mark, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import CharacterCount from "@tiptap/extension-character-count";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import TextAlign from "@tiptap/extension-text-align";
import {
  TextStyle,
  Color,
  FontFamily,
  FontSize,
  LineHeight,
} from "@tiptap/extension-text-style";
import { Collaboration } from "@tiptap/extension-collaboration";
import { AttachmentNode } from "./tiptap-attachment.js";
import {
  yCursorPlugin,
  defaultCursorBuilder,
  defaultSelectionBuilder,
} from "@tiptap/y-tiptap";

export const FONT_FAMILIES = [
  "Arial",
  "Calibri",
  "Times New Roman",
  "Georgia",
  "Verdana",
  "Courier New",
  "Tahoma",
  "Trebuchet MS",
];

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

export const LINE_HEIGHTS = ["1", "1.15", "1.5", "1.75", "2", "2.5", "3"];

export const COLORS = [
  { name: "Default", value: undefined },
  { name: "Black", value: "#000000" },
  { name: "Dark gray", value: "#52525b" },
  { name: "Gray", value: "#71717a" },
  { name: "Red", value: "#dc2626" },
  { name: "Orange", value: "#ea580c" },
  { name: "Yellow", value: "#ca8a04" },
  { name: "Green", value: "#16a34a" },
  { name: "Blue", value: "#2563eb" },
  { name: "Purple", value: "#9333ea" },
];

const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: false,
  parseHTML() {
    return [{ tag: "div[data-pagebreak='1']" }];
  },
  renderHTML() {
    return ["div", { "data-pagebreak": "1" }];
  },
  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ chain }) =>
          chain().insertContent({ type: this.name }).run(),
    };
  },
});

/**
 * Highlight mark used to tint text that has an open comment thread.
 *
 * The comment id lives in the mark's `data-comment` attribute, so clicking a
 * highlight in the document can jump straight to the matching thread. The mark
 * is part of the shared Yjs document, which is intentional: every collaborator
 * sees the same highlighted regions.
 */
const CommentHighlight = Mark.create({
  name: "commentHighlight",
  inclusive: false,
  excludes: "",

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-comment"),
        renderHTML: (attrs) =>
          attrs.commentId ? { "data-comment": attrs.commentId } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "mark[data-comment]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes, { class: "comment-highlight" })];
  },

  addCommands() {
    return {
      /** Mark the current selection as belonging to a comment thread. */
      setCommentHighlight:
        (commentId) =>
        ({ commands }) =>
          commands.setMark(this.name, { commentId }),

      /** Clear the mark from the current selection. */
      unsetCommentHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),

      /**
       * Mark an explicit range. Used when a thread is created or reopened, where
       * the range is not the live selection.
       */
      setCommentHighlightInRange:
        (commentId, from, to) =>
        ({ tr, state }) => {
          if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) return false;
          const max = state.doc.content.size;
          const start = Math.max(0, Math.min(from, max));
          const end = Math.max(start, Math.min(to, max));
          tr.addMark(start, end, this.type.create({ commentId }));
          return true;
        },

      /**
       * Drop every mark belonging to a thread, wherever it currently sits.
       * Resolving or deleting a thread must not leave a stale highlight behind,
       * and the range may have drifted since the comment was created.
       */
      removeCommentHighlightById:
        (commentId) =>
        ({ tr, state, dispatch }) => {
          if (!commentId) return false;
          if (dispatch) tr.doc.descendants((node, pos) => {
            if (!node.isText) return;
            const mark = node.marks.find(
              (m) => m.type === this.type && m.attrs.commentId === commentId
            );
            if (mark) tr.removeMark(pos, pos + node.nodeSize);
          });
          return true;
        },
    };
  },
});

const CollabCursor = Extension.create({
  name: "collabCursor",
  addOptions() {
    return { provider: null, user: null };
  },
  addProseMirrorPlugins() {
    const { provider, user } = this.options;
    if (!provider) return [];
    if (user) provider.awareness.setLocalStateField("user", user);
    return [
      yCursorPlugin(provider.awareness, {
        cursorBuilder: defaultCursorBuilder,
        selectionBuilder: defaultSelectionBuilder,
      }),
    ];
  },
});

/**
 * Build the Tiptap extension list.
 *
 * @param {object}  options
 * @param {import("yjs").Doc|null} options.ydoc   Shared document; enables collaboration.
 * @param {object|null} options.provider          y-websocket provider.
 * @param {object|null} options.user              Current user, for the presence cursor.
 * @param {object}  options.mentionRender        Custom @mention popup renderer; passed
 *                                               to @tiptap/suggestion as `render: () => renderer`.
 */
export function buildExtensions({
  ydoc = null,
  provider = null,
  user = null,
  mentionRender = null,
} = {}) {
  const extensions = [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: false,
      underline: false,
    }),
    Underline,
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    LineHeight.configure({ types: ["heading", "paragraph", "blockquote"] }),
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ["heading", "paragraph", "blockquote"] }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: "https",
    }),
    Image.configure({ allowBase64: false }),
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: "Type something..." }),
    CharacterCount,
    PageBreak,
    CommentHighlight,
    AttachmentNode,
  ];

  // @mentions: type "@name" to notify a teammate. The suggestion list is rendered
  // by the host app so the popup can reuse the app's own styling primitives.
  //
  // @tiptap/suggestion calls `render()` and expects the lifecycle handlers back,
  // so the shared renderer is passed as a factory rather than as a bare object.
  if (mentionRender) {
    extensions.push(
      Mention.configure({
        HTMLAttributes: { class: "mention" },
        suggestion: {
          char: "@",
          allowSpaces: false,
          render: () => mentionRender,
        },
      })
    );
  }

  if (ydoc) {
    extensions.push(
      Collaboration.configure({ document: ydoc, provider }),
      CollabCursor.configure({ provider, user }),
    );
  }

  return extensions;
}

export function deriveTitle(text) {
  const line = String(text || "")
    .split("\n")
    .map((x) => x.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}...` : line;
}

export function isPlaceholderTitle(t) {
  return !t || /^Untitled\d*$/.test(t);
}