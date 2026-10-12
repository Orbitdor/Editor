"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  getDoc,
  saveDoc,
  createDoc,
  getDocVersions,
  restoreVersion,
  exportDocBlob,
  tagDoc,
  getComments,
  createComment,
  replyToComment,
  editComment,
  resolveComment,
  deleteComment,
} from "@/lib/api";
import { getUser, clearSession } from "@/lib/auth";
import { buildExtensions, deriveTitle, isPlaceholderTitle } from "@/lib/tiptap";
import { getMentionRenderer } from "@/lib/mention-render";
import {
  createCollab,
  destroyCollab,
  reviveCollab,
  seedCollab,
  subscribeCollabUsers,
  subscribeCollabStatus,
  onCollabSync,
  collabUserInfo,
} from "@/lib/editor-sync";
import { TopRuler, LeftRuler } from "@/components/Rulers";
import MenuBar from "@/components/MenuBar";
import Toolbar from "@/components/Toolbar";
import CommentsPanel from "@/components/CommentsPanel";
import ShareDialog from "@/components/ShareDialog";
import SaveTemplateDialog from "@/components/SaveTemplateDialog";
import NotificationBell from "@/components/NotificationBell";
import UserMenu from "@/components/UserMenu";
import AiPanel from "@/components/AiPanel";
import VoicePanel from "@/components/VoicePanel";
import OcrDialog from "@/components/OcrDialog";
import IntegrationCenter, { IntegrationCenterButton } from "@/components/integration-center";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { History, Loader2, MessageSquare, Mic, ScanText, Share2, Sparkles, Tag } from "lucide-react";
import { cn } from "@/lib/utils";

function initials(name) {
  const chars = String(name || "?")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ]/gu, "");
  const parts = chars.split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts
    .slice(0, 2)
    .map((w) => (w[0] || "").toUpperCase())
    .join("");
}

/**
 * Icon-only header action with a hover tooltip.
 *
 * The header carries four utility actions (AI, dictation, OCR, comments) that a
 * document editor keeps as glyphs; a text label on each one pushes the share
 * controls off a laptop screen. `active` marks the panel that is currently open
 * and reads as selected rather than the flat grey `variant="secondary"` gave us,
 * and `badge` keeps the unresolved-comment count on the glyph instead of an
 * inline badge that made the button resize.
 */
function HeaderIconBtn({ label, active = false, badge = 0, disabled, onClick, children }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "relative text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
            active && "bg-zinc-100 text-zinc-900"
          )}
        >
          {children}
          {badge > 0 ? (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-semibold leading-none text-white">
              {badge > 99 ? "99+" : badge}
            </span>
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

const PAGE_W = 794;
const PAGE_H = 1123;
const PAD_R = 72;
const PAD_B = 72;

/** Default capabilities for an unknown role: read-only, no comments. */
const NO_ACCESS = { role: "none", canEdit: false, canComment: false, canShare: false };

export default function Editor() {
  const { id } = useParams();
  const router = useRouter();
  const [title, setTitle] = useState("Untitled");
  const [loaded, setLoaded] = useState(false);
  const [rev, setRev] = useState(0);
  const [mode, setMode] = useState("editing");
  const [indentLeft, setIndentLeft] = useState(56);
  const [indentTop, setIndentTop] = useState(48);
  const [saveState, setSaveState] = useState("saved");
  const savingRef = useRef(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState([]);
  const [tags, setTags] = useState([]);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagsInput, setTagsInput] = useState("");
  const [initialDoc, setInitialDoc] = useState(null);
  // Signed-in display profile for the header account menu. Read one frame after
  // mount so the server render and the first client render agree on `null`.
  const [me, setMe] = useState(null);
  const [collabUsers, setCollabUsers] = useState([]);

  // --- Collaboration state ---
  // `access` drives every permission-aware UI branch in this page.
  const [access, setAccess] = useState(NO_ACCESS);
  // Users without edit rights always start (and stay) in read-only mode.
  // Deriving it during render avoids a state update inside an effect.
  const effectiveMode = access.canEdit ? mode : "viewing";
  const viewOnly = effectiveMode === "viewing";
  const [threads, setThreads] = useState([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [pendingComment, setPendingComment] = useState(null);
  // Which thread the reader has in focus, so the panel can reveal it. Set when
  // a highlight is clicked in the document or a thread is picked in the panel.
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);

  // --- AI / OCR state ---
  // The AI panel and the OCR dialog are mutually exclusive overlays: the panel
  // is docked beside the editor, the dialog is modal.
  const [aiOpen, setAiOpen] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [googleOpen, setGoogleOpen] = useState(false);
  // Dictation is a third overlay, docked like the AI panel so the document stays
  // visible while the user speaks.
  const [voiceOpen, setVoiceOpen] = useState(false);
  // Text currently selected in the editor, handed to the AI panel as its target.
  const [aiSelection, setAiSelection] = useState("");

  const titleRef = useRef(null);
  const editorRef = useRef(null);
  const dirtyRef = useRef(false);
  const loadedRef = useRef(false);
  const saveNowRef = useRef(null);
  // The mention popup is app-wide global UI owned by @tiptap/suggestion, not
  // React state, so it lives in a lazily created module singleton.

  const [collab] = useState(() =>
    typeof window !== "undefined"
      ? createCollab({ docId: String(id), user: getUser() || {} })
      : null
  );
  const collabUser = typeof window !== "undefined" ? collabUserInfo(getUser()) : null;
  /** Signed-in user, needed to mark "you" in comments. */
  const currentUser = typeof window !== "undefined" ? getUser() : null;

  const editor = useEditor({
    immediatelyRender: false,
    extensions: buildExtensions({
      ydoc: collab?.ydoc ?? null,
      provider: collab?.provider ?? null,
      user: collabUser,
      mentionRender: getMentionRenderer(),
    }),
    content: "",
    editable: !viewOnly,
    editorProps: {
      attributes: {
        class: "outline-none min-h-[55vh]",
        spellcheck: "true",
      },
      handleKeyDown(_view, event) {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          saveNowRef.current?.();
          return true;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          editorRef.current?.chain().focus().setPageBreak().run();
          return true;
        }
        return false;
      },
    },
    onUpdate({ editor: ed }) {
      if (!loadedRef.current) return;
      dirtyRef.current = true;
      editorRef.current = ed;
      setRev((r) => r + 1);
    },
    onSelectionUpdate({ editor: ed }) {
      handleSelectionUpdate({ editor: ed });
    },
  });

  // Profile for the header account menu: localStorage is not readable during
  // the server render, so this settles a frame after mount.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMe(getUser()));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);

  // Keep the editor editable in sync with the access role and the view/edit
  // toggle. This is a side effect on the editor instance, not React state.
  useEffect(() => {
    editorRef.current?.setEditable(!viewOnly);
  }, [viewOnly]);

  useEffect(() => {
    if (!collab) return;
    reviveCollab(String(id));
    const offUsers = subscribeCollabUsers(collab, setCollabUsers);
    // The header no longer shows a connection badge, but the status hook still
    // has to be attached: it wires the provider's reconnect handling.
    const offStatus = subscribeCollabStatus(collab, () => {});
    return () => {
      offUsers();
      offStatus();
      destroyCollab(String(id));
    };
  }, [id, collab]);

  useEffect(() => {
    if (!editor || !loaded || !initialDoc || !collab) return;
    if (collab.seeded) return;

    const trySeed = () => {
      if (collab.seeded) return;
      if (seedCollab(collab, editor, initialDoc)) {
        dirtyRef.current = true;
        setRev((r) => r + 1);
      }
    };

    if (collab.provider) {
      let fallback;
      const offSync = onCollabSync(collab, (synced) => {
        if (synced) {
          offSync();
          clearTimeout(fallback);
          trySeed();
        }
      });
      fallback = setTimeout(trySeed, 2500);
      return () => {
        offSync();
        clearTimeout(fallback);
      };
    }
    trySeed();
    return undefined;
  }, [editor, loaded, initialDoc, rev, collab]);

  const loadDoc = useCallback(async () => {
    let doc;
    try {
      doc = await getDoc(id);
    } catch (err) {
      // The session cookie is HttpOnly, so the API's 401 is the only signal that
      // it has expired. Recovering a refresh is the client's job; by the time a
      // 401 reaches here the retry already failed, so the user has to sign in.
      if (err.status === 401) {
        clearSession();
        router.replace("/login");
        return;
      }
      throw err;
    }
    setTags(doc.tags || []);
    // The API returns the caller's role, which is the single source of truth
    // for what the UI is allowed to offer.
    setAccess(doc.access || NO_ACCESS);
    const initial = isPlaceholderTitle(doc.title)
      ? deriveTitle(doc.plainText || doc.content || "") || doc.title || "Untitled"
      : doc.title;
    titleRef.current = initial;
    setTitle(initial);
    setInitialDoc(doc);
    setLoaded(true);
  }, [id, router]);

  // Comments live outside the Yjs document, so they are fetched separately and
  // refreshed whenever the panel is opened.
  const loadComments = useCallback(async () => {
    if (!access.canComment && access.role === "none") return;
    setCommentsLoading(true);
    try {
      setThreads(await getComments(id));
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not load comments");
    } finally {
      setCommentsLoading(false);
    }
  }, [id, access.canComment, access.role]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      loadDoc().catch((err) => {
        console.error(err);
        toast.error(err.message || "Could not load document");
        setLoaded(true);
      });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const resolveTitle = useCallback(() => {
    if (isPlaceholderTitle(titleRef.current)) {
      const derived = editor ? deriveTitle(editor.getText()) : "";
      if (derived) {
        titleRef.current = derived;
        setTitle(derived);
        return derived;
      }
    }
    return titleRef.current;
  }, [editor]);

  const doSave = useCallback(async () => {
    if (savingRef.current || !editor) return;
    savingRef.current = true;
    setSaveState("saving");
    const payload = {
      title: resolveTitle(),
      content: editor.getHTML(),
      contentJson: editor.getJSON(),
    };
    try {
      await saveDoc(id, payload);
      dirtyRef.current = false;
      setSaveState("saved");
    } catch (err) {
      console.error(err);
      setSaveState("error");
    } finally {
      savingRef.current = false;
    }
  }, [id, editor, resolveTitle]);

  const saveNow = useCallback(() => {
    doSave();
  }, [doSave]);

  useEffect(() => {
    saveNowRef.current = saveNow;
  }, [saveNow]);

  useEffect(() => {
    if (!loaded || !dirtyRef.current) return;
    const t = setTimeout(() => {
      doSave();
    }, 1000);
    return () => clearTimeout(t);
  }, [rev, title, id, loaded, doSave]);

  async function handleNew() {
    const doc = await createDoc();
    router.push(`/editor/${doc._id}`);
  }

  function openVersions() {
    getDocVersions(id)
      .then((list) => {
        setVersions(list);
        setVersionsOpen(true);
      })
      .catch((err) => {
        console.error(err);
        toast.error(err.message || "Could not load versions");
      });
  }

  async function handleRestore(version) {
    if (
      !window.confirm(
        `Restore version v${version.version}? Current content will be saved as a new version first.`
      )
    ) {
      return;
    }
    try {
      await restoreVersion(id, version.version);
      setVersionsOpen(false);
      toast.success("Version restored");
      setSaveState("saved");
      dirtyRef.current = false;
      await loadDoc();
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not restore version");
    }
  }

  const BINARY_EXPORTS = ["pdf", "docx"];

  async function handleExport(format) {
    const binary = BINARY_EXPORTS.includes(format);
    // Rendering happens on the server and is slow on a large document, so say
    // something rather than leaving the menu looking like it did nothing.
    const toastId = binary ? toast.loading(`Preparing ${format.toUpperCase()}...`) : null;
    try {
      const { blob, filename } = await exportDocBlob(id, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (toastId) toast.success(`Exported ${filename}`);
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not export document");
    } finally {
      // Dismissing the loading toast is what replaces it with the outcome.
      if (toastId) toast.dismiss(toastId);
    }
  }

  function openTags() {
    setTagsInput(tags.join(", "));
    setTagsOpen(true);
  }

  async function saveTags() {
    const list = tagsInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
    try {
      const updated = await tagDoc(id, list);
      setTags(updated.tags || list);
      setTagsOpen(false);
      toast.success("Tags updated");
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not save tags");
    }
  }

  /**
   * Open the comments panel and, when there is a text selection, start a new
   * thread anchored to it. The comment composer is a dialog so the text stays
   * visible while typing the note.
   */
  async function addComment() {
    if (!access.canComment) {
      toast.error("You do not have permission to comment on this document");
      return;
    }

    const ed = editorRef.current;
    const { from, to } = ed?.state?.selection || {};
    const selected = ed && from !== to ? ed.state.doc.textBetween(from, to, " ") : "";

    setPendingComment({
      quotedText: selected,
      from: selected ? from : null,
      to: selected ? to : null,
    });
    setCommentsOpen(true);
    await loadComments();
  }

  /**
   * Find a text range in the document by its content.
   *
   * Comment anchors are stored as absolute positions, which drift as other people
   * edit around them. Quoted text is the durable fallback, so it is what we use
   * to re-anchor highlights and to move the selection.
   *
   * @param {import("@tiptap/core").Editor|null} ed
   * @param {string} needle
   * @returns {{from: number, to: number}|null}
   */
  function findTextRange(ed, needle) {
    if (!ed || !needle) return null;
    const target = needle.trim();
    if (!target) return null;

    // Collect the text of every text node with its document position, so the
    // match can be scored by how much of it lines up with the quote.
    const chunks = [];
    let joined = "";
    ed.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      chunks.push({ pos, text: node.text, offset: joined.length });
      joined += node.text;
    });

    if (!joined.includes(target)) return null;

    // Try the shortest offsets first: a later match is a better guess than an
    // early prefix match when the quote appears more than once.
    const candidates = [];
    let from = joined.indexOf(target);
    while (from !== -1) {
      candidates.push(from);
      from = joined.indexOf(target, from + 1);
    }

    let best = null;
    for (const start of candidates) {
      const chunk = chunks.find((c) => start >= c.offset && start < c.offset + c.text.length);
      if (!chunk) continue;
      const local = start - chunk.offset;
      const endLocal = Math.min(local + target.length, chunk.text.length);
      const range = { from: chunk.pos + local, to: chunk.pos + endLocal };
      if (!best) best = range;
    }
    return best;
  }

  /** Apply (or clear) the shared highlight that ties document text to a thread. */
  function syncHighlight(thread, shouldHighlight) {
    const ed = editorRef.current;
    if (!ed || !thread) return;

    if (!shouldHighlight) {
      ed.commands.removeCommentHighlightById(thread.id);
      return;
    }

    const range = findTextRange(ed, thread.quotedText);
    if (range) ed.commands.setCommentHighlightInRange(thread.id, range.from, range.to);
  }

  /** Persist a new thread, highlight its anchor and refresh the panel. */
  async function submitComment(body) {
    if (!pendingComment) return;
    try {
      const created = await createComment(id, {
        body,
        quotedText: pendingComment.quotedText,
        from: pendingComment.from,
        to: pendingComment.to,
      });
      if (created?.id) syncHighlight({ id: created.id, quotedText: created.quotedText }, true);
      setPendingComment(null);
      setThreads(await getComments(id));
      toast.success("Comment added");
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not add comment");
    }
  }

  async function handleReply(threadId, body) {
    try {
      await replyToComment(id, threadId, body);
      setThreads(await getComments(id));
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not reply");
    }
  }

  async function handleEditComment(commentId, body) {
    try {
      await editComment(id, commentId, body);
      setThreads(await getComments(id));
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not edit comment");
    }
  }

  async function handleResolve(thread, resolved) {
    try {
      await resolveComment(id, thread.id, resolved);
      // A resolved thread stops drawing attention to its text, and reopening it
      // puts the highlight back where the quote still lives.
      syncHighlight(thread, !resolved);
      setThreads(await getComments(id));
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not update thread");
    }
  }

  async function handleDeleteComment(thread) {
    if (!window.confirm("Delete this thread and all of its replies?")) return;
    try {
      await deleteComment(id, thread.id);
      syncHighlight(thread, false);
      setThreads(await getComments(id));
    } catch (err) {
      console.error(err);
      toast.error(err.message || "Could not delete comment");
    }
  }

  /**
   * Focus a thread from either direction: the panel list or a document
   * highlight. Scrolling happens on the next frame because the panel renders
   * the focus highlight from this same state.
   */
  function selectThread(thread) {
    setActiveThreadId(thread?.id || null);
    if (!thread) return;
    if (commentsOpen) {
      jumpToThread(thread);
    }
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-thread-id="${thread.id}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }

  /**
   * Track the current selection so the AI panel knows whether it should act on
   * a fragment or on the whole document. Capped so dragging across a long
   * document cannot flood state with megabytes of text.
   */
  const MAX_AI_SELECTION = 4000;
  function handleSelectionUpdate({ editor: ed }) {
    if (!ed) return;
    const text = ed.state.doc.textBetween(
      ed.state.selection.from,
      ed.state.selection.to,
      "\n",
      " "
    );
    setAiSelection(text.length > MAX_AI_SELECTION ? text.slice(0, MAX_AI_SELECTION) : text);
  }

  /**
   * Insert AI or OCR output at the caret.
   *
   * A blank line between blocks becomes a real paragraph break so pasted output
   * keeps its structure instead of collapsing into one run of text.
   */
  function insertAtCaret(text) {
    if (!text || !editorRef.current) return;
    const blocks = String(text)
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => ({
        type: "paragraph",
        content: block.split("\n").map((line) => ({ type: "text", text: line })),
      }));

    if (!blocks.length) return;
    editorRef.current.chain().focus().insertContent(blocks).run();
  }

  /** Replace the live selection with AI output. */
  function replaceSelection(text) {
    if (!text || !editorRef.current) return;
    editorRef.current
      .chain()
      .focus()
      .insertContentAt(editorRef.current.state.selection, String(text))
      .run();
  }

  /**
   * Apply a spoken editing command to the editor.
   *
   * The command arrives from the dictation pipeline and describes what should
   * happen to the block the transcript is about to land in, so each one changes
   * the current block before the text is inserted.
   *
   * @param {string} id Command id from `VOICE_COMMANDS`.
   */
  function applyVoiceCommand(id) {
    const ed = editorRef.current;
    if (!ed || !access.canEdit) return;

    switch (id) {
      case "newParagraph":
        ed.chain().focus().splitBlock().run();
        break;
      case "newHeading":
        ed.chain().focus().setNode("heading", { level: 2 }).run();
        break;
      case "bold":
        ed.chain().focus().toggleMark("bold").run();
        break;
      case "italic":
        ed.chain().focus().toggleMark("italic").run();
        break;
      case "underline":
        ed.chain().focus().toggleMark("underline").run();
        break;
      case "bulletList":
        ed.chain().focus().toggleBulletList().run();
        break;
      case "numberedList":
        ed.chain().focus().toggleOrderedList().run();
        break;
      case "deleteSentence": {
        // Remove the sentence before the caret, if there is one.
        const { $from } = ed.state.selection;
        const block = $from.parent.textContent;
        const upToCaret = block.slice(0, $from.parentOffset);
        const boundary = Math.max(upToCaret.lastIndexOf(". "), upToCaret.lastIndexOf(".\n"));
        if (boundary < 0) {
          toast.info("No earlier sentence to delete");
          break;
        }
        const from = $from.start() + boundary + 1;
        ed.chain().focus().deleteRange({ from, to: $from.pos }).run();
        break;
      }
      case "insertPageBreak":
        ed.chain().focus().setPageBreak().run();
        break;
      case "stop":
        setVoiceOpen(false);
        break;
      default:
        // Unknown command: leave the document alone rather than guessing.
        break;
    }
  }

  /**
   * Move the editor selection to a comment's anchor so the panel and the
   * document stay in sync. Falls back to searching the quoted text when the
   * stored positions have drifted.
   */
  function jumpToThread(thread) {
    const ed = editorRef.current;
    if (!ed) return;

    const { from, to } = thread.anchor || {};
    if (Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= ed.state.doc.content.size) {
      ed.chain().focus().setTextSelection({ from, to }).scrollIntoView().run();
      return;
    }

    const range = findTextRange(ed, thread.quotedText);
    if (range) {
      ed.chain().focus().setTextSelection(range).scrollIntoView().run();
      return;
    }
    toast.info("Could not locate the highlighted text");
  }

  const insertPageBreak = useCallback(() => {
    editorRef.current?.chain().focus().setPageBreak().run();
  }, []);

  // Unresolved threads drive the comments button badge.
  const openThreads = threads.filter((t) => !t.resolved).length;

  return (
    <div className="flex h-dvh flex-col">
      <div className="no-print sticky top-0 z-30 border-b border-zinc-200 bg-white">
        <div className="flex items-center gap-3 px-4 py-2">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md p-1 transition-colors hover:bg-zinc-100"
            title="Doc Editor"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5 text-blue-600"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M9 13h6" />
              <path d="M9 17h6" />
            </svg>
            <span className="text-sm font-semibold text-blue-600">
              Doc Editor
            </span>
          </Link>
          <Input
            ref={titleRef}
            value={title}
            readOnly={viewOnly}
            size={title.length ? title.length + 1 : 8}
            onChange={(e) => {
              setTitle(e.target.value);
              titleRef.current = e.target.value;
              dirtyRef.current = true;
            }}
            className="h-7 w-auto min-w-[3rem] max-w-[60%] px-2 py-1 text-sm font-medium [field-sizing:content]"
            placeholder="Untitled"
          />
          {loaded ? (
            <Badge
              variant={saveState === "error" ? "destructive" : "outline"}
              className="text-xs font-normal"
            >
              {saveState === "saving"
                ? "Saving..."
                : saveState === "error"
                  ? "Save failed"
                  : "Saved"}
            </Badge>
          ) : null}
          <div className="flex items-center gap-2">
            {collabUsers.filter((u) => !u.self).length ? (
              <div className="no-print flex -space-x-1.5">
                {collabUsers
                  .filter((u) => !u.self)
                  .map((u, i) => (
                    <span
                      key={`${u.email}-${u.name}-${i}`}
                      title={u.name}
                      className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-[10px] font-semibold text-white"
                      style={{ backgroundColor: u.color, zIndex: collabUsers.length - i }}
                    >
                      {initials(u.name)}
                    </span>
                  ))}
              </div>
            ) : null}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {/* Notifications */}
            <NotificationBell />

            {/*
              Utility glyphs. Every document editor keeps these four as icons so
              the share controls stay visible on a laptop, so the labels move
              into tooltips and the open panel marks itself with `active`.
            */}
            <TooltipProvider delayDuration={150}>
              <div className="flex items-center gap-0.5">
                {/* AI assistant */}
                <HeaderIconBtn
                  label="AI writing assistant"
                  active={aiOpen}
                  onClick={() => {
                    const next = !aiOpen;
                    setAiOpen(next);
                    if (next) {
                      setCommentsOpen(false);
                      setVoiceOpen(false);
                    }
                  }}
                >
                  <Sparkles className="size-4" />
                </HeaderIconBtn>

                {/* Dictation */}
                <HeaderIconBtn
                  label={
                    access.canEdit ? "Dictate with your voice" : "Editing access required"
                  }
                  active={voiceOpen}
                  disabled={!access.canEdit}
                  onClick={() => {
                    const next = !voiceOpen;
                    setVoiceOpen(next);
                    if (next) {
                      setAiOpen(false);
                      setCommentsOpen(false);
                    }
                  }}
                >
                  <Mic className="size-4" />
                </HeaderIconBtn>

                {/* OCR */}
                <HeaderIconBtn
                  label={access.canEdit ? "Extract text from an image" : "Editing access required"}
                  disabled={!access.canEdit}
                  onClick={() => setOcrOpen(true)}
                >
                  <ScanText className="size-4" />
                </HeaderIconBtn>
              </div>

              {/* Writing tools end, reviewing begins. */}
              <div aria-hidden className="mx-1.5 h-5 w-px bg-zinc-200" />

              {/* Comments */}
              <HeaderIconBtn
                label={openThreads > 0 ? `Comments (${openThreads} open)` : "Comments"}
                active={commentsOpen}
                badge={openThreads}
                onClick={() => {
                  const next = !commentsOpen;
                  setCommentsOpen(next);
                  if (next) {
                    setAiOpen(false);
                    setVoiceOpen(false);
                    loadComments();
                  }
                }}
              >
                <MessageSquare className="size-4" />
              </HeaderIconBtn>
            </TooltipProvider>

            {/* Share */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShareOpen(true)}
              title={access.canShare ? "Share and manage access" : "View access"}
            >
              <Share2 />
              Share
            </Button>

            {access.canShare ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={openVersions}
                title="Version history"
              >
                <History />
                History
              </Button>
            ) : null}
            {access.canShare ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={openTags}
                title="Edit tags"
              >
                <Tag />
                Tags
                {tags.length ? (
                  <Badge variant="secondary" className="px-1.5 text-[10px]">
                    {tags.length}
                  </Badge>
                ) : null}
              </Button>
            ) : null}

            {/* Account menu sits last, at the far right, where a document
                editor keeps it -- the collaborator stack next to the title is
                for other people, not for you. */}
            <div aria-hidden className="mx-1 h-5 w-px bg-zinc-200" />
            <UserMenu user={me} />
          </div>
        </div>
        <MenuBar
          editor={editor}
          onNew={handleNew}
          onSave={saveNow}
          onRename={() => titleRef.current?.focus()}
          onExport={handleExport}
          onVersions={openVersions}
          onTags={openTags}
          onSaveTemplate={() => setSaveTemplateOpen(true)}
          onShare={() => setShareOpen(true)}
          canShare={access.canShare}
          canEdit={access.canEdit}
        />
        <Toolbar
          editor={editor}
          mode={effectiveMode}
          setMode={setMode}
          onAddComment={addComment}
          onInsertPageBreak={insertPageBreak}
          commentsOpen={commentsOpen}
          setCommentsOpen={setCommentsOpen}
          // Attachments are scoped to the document, so the upload buttons need
          // its id.
          documentId={id}
          // Commenters and viewers can never enter edit mode.
          canEdit={access.canEdit}
        />
      </div>

      {loaded ? (
        <div className="flex flex-1 overflow-hidden">
          <div className="editor-canvas relative flex-1 overflow-auto bg-[#e8eaed] px-4 py-10">
            <div className="print-hide absolute left-0 top-[120px] z-10 w-[18px]">
              <LeftRuler
                height={PAGE_H}
                indentTop={indentTop}
                onIndentTop={setIndentTop}
              />
            </div>
            <div className="mx-auto w-fit">
              <div className="print-hide pb-2">
                <TopRuler
                  width={PAGE_W}
                  indentLeft={indentLeft}
                  onIndentLeft={setIndentLeft}
                />
              </div>
              <div
                className="paper relative w-[794px] border border-zinc-200 bg-white shadow-sm"
                style={{
                  paddingTop: indentTop,
                  paddingRight: PAD_R,
                  paddingBottom: PAD_B,
                  paddingLeft: indentLeft,
                  minHeight: PAGE_H,
                }}
              >
                <EditorContent
                  editor={editor}
                  className="tx-content"
                  // Clicking highlighted text opens its thread in the panel.
                  onClick={(event) => {
                    const mark = event.target.closest?.("mark[data-comment]");
                    if (!mark) return;
                    const threadId = mark.getAttribute("data-comment");
                    const thread = threads.find((t) => t.id === threadId);
                    if (!thread) return;
                    setCommentsOpen(true);
                    selectThread(thread);
                  }}
                />
              </div>
            </div>

            {/* Version history */}
            {versionsOpen ? (
              <Dialog open={versionsOpen} onOpenChange={setVersionsOpen}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Version history</DialogTitle>
                    <DialogDescription>
                      Restore any earlier version of this document.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="max-h-96 space-y-2 overflow-y-auto">
                    {versions.length === 0 ? (
                      <p className="py-4 text-sm text-zinc-500">No versions yet.</p>
                    ) : (
                      versions.map((v) => (
                        <div
                          key={v._id}
                          className="flex items-start justify-between gap-3 rounded-md border border-zinc-200 p-3"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-zinc-800">
                              v{v.version}
                            </div>
                            <div className="mt-0.5 truncate text-xs text-zinc-500">
                              {v.title || "Untitled"}
                            </div>
                            <div className="text-[10px] text-zinc-400">
                              {new Date(v.updatedAt).toLocaleString()}
                            </div>
                          </div>
                          <Button variant="outline" size="sm" onClick={() => handleRestore(v)}>
                            Restore
                          </Button>
                        </div>
                      ))
      )}

                  </div>
                </DialogContent>
              </Dialog>
            ) : null}

            {/* Tags */}
            {tagsOpen ? (
              <Dialog open={tagsOpen} onOpenChange={setTagsOpen}>
                <DialogContent className="sm:max-w-sm">
                  <DialogHeader>
                    <DialogTitle>Tags</DialogTitle>
                    <DialogDescription>
                      Comma-separated tags to organize this document.
                    </DialogDescription>
                  </DialogHeader>
                  <Input
                    value={tagsInput}
                    onChange={(e) => setTagsInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveTags();
                    }}
                    placeholder="project, notes"
                  />
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setTagsOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={saveTags}>Save</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            ) : null}
          </div>

          {/* Comments side panel */}
          {commentsOpen ? (
            <CommentsPanel
              key={String(id)}
              onClose={() => setCommentsOpen(false)}
              threads={threads}
              loading={commentsLoading}
              currentUserId={currentUser?.id}
              canComment={access.canComment}
              canDelete={access.canEdit}
              activeId={activeThreadId}
              onSelect={selectThread}
              onReply={handleReply}
              onEdit={handleEditComment}
              onResolve={handleResolve}
              onDelete={handleDeleteComment}
            />
          ) : null}

          {/* AI side panel. Mounted only while open so it stops polling the
              quota endpoint the rest of the time. Docked beside the editor on
              wide screens, and a full-screen sheet on narrow ones where a
              docked column would squeeze the page to nothing. */}
          {aiOpen ? (
            <div className="fixed inset-0 z-40 bg-white md:static md:z-auto md:w-[320px] md:flex-none md:bg-transparent">
              <AiPanel
                documentId={String(id)}
                selection={aiSelection}
                canEdit={access.canEdit}
                onInsert={insertAtCaret}
                onReplace={replaceSelection}
                onClose={() => setAiOpen(false)}
              />
            </div>
          ) : null}

          {/* Dictation side panel. Same docking as the AI panel, and mounted only
              while open so the microphone is never held in the background. */}
          {voiceOpen ? (
            <div className="fixed inset-0 z-40 bg-white md:static md:z-auto md:w-[320px] md:flex-none md:bg-transparent">
              <VoicePanel
                documentId={String(id)}
                canEdit={access.canEdit}
                onInsert={insertAtCaret}
                onCommand={applyVoiceCommand}
                onClose={() => setVoiceOpen(false)}
              />
            </div>
          ) : null}
        </div>
      ) : (        <div className="editor-canvas flex flex-1 flex-col items-center overflow-auto bg-[#e8eaed] px-4 py-10">
          <div className="mx-auto w-full max-w-[840px]">
            <Skeleton className="h-9 w-full rounded-sm bg-white/70" />
            <div className="flex flex-col items-center rounded-lg border border-zinc-200 bg-white p-10 shadow-sm">
              <Skeleton className="w-64 max-w-full" />
              <Skeleton className="mt-2 w-40 max-w-full" />
              <div className="mt-10 grid w-full gap-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="mt-6 h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            </div>
          <div className="mt-4 flex items-center justify-center gap-2 text-sm text-zinc-400">
            <Loader2 className="size-4 animate-spin" />
            Loading document...
          </div>
          </div>
        </div>
      )}

      {/* Mobile action bar (master plan section 42).
          The header row of glyphs does not fit a phone, so voice, AI, OCR and
          comments get a thumb-reachable bar instead. It lives at the root level
          of the column layout -- nesting it in a dialog kept it from ever
          reaching the screen. */}
      {loaded ? (
        <div className="print-hide flex items-center justify-around gap-1 border-t border-zinc-200 bg-white px-2 py-1.5 md:hidden">
          <Button
            type="button"
            variant={voiceOpen ? "secondary" : "ghost"}
            size="sm"
            disabled={!access.canEdit}
            onClick={() => {
              setVoiceOpen((v) => !v);
              setAiOpen(false);
              setCommentsOpen(false);
            }}
            title={access.canEdit ? "Dictate" : "Editing access required"}
          >
            <Mic className="size-4" />
            Voice
          </Button>
          <Button
            type="button"
            variant={aiOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              setAiOpen((v) => !v);
              setVoiceOpen(false);
              setCommentsOpen(false);
            }}
            title="AI writing assistant"
          >
            <Sparkles className="size-4" />
            AI
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!access.canEdit}
            onClick={() => setOcrOpen(true)}
            title={access.canEdit ? "Extract text from an image" : "Editing access required"}
          >
            <ScanText className="size-4" />
            OCR
          </Button>
          <IntegrationCenterButton onClick={() => setGoogleOpen(true)} />
          <Button
            type="button"
            variant={commentsOpen ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              setCommentsOpen((v) => !v);
              setAiOpen(false);
              setVoiceOpen(false);
              if (!commentsOpen) loadComments();
            }}
            title="Comments"
          >
            Comments
            {openThreads > 0 ? (
              <Badge variant="secondary" className="ml-1 text-[10px]">
                {openThreads}
              </Badge>
            ) : null}
          </Button>
        </div>
      ) : null}

      {/* Share dialog */}
      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        docId={String(id)}
        docTitle={title}
        isOwner={access.canShare}
      />

      {/* Save the current body as a reusable workspace template */}
      <SaveTemplateDialog
        open={saveTemplateOpen}
        onOpenChange={setSaveTemplateOpen}
        docId={String(id)}
        docTitle={title}
        workspaceId={initialDoc?.workspace}
      />

      {/* Image to text (OCR) */}
      {ocrOpen ? (
        <OcrDialog
          documentId={String(id)}
          canEdit={access.canEdit}
          onInsert={insertAtCaret}
          onClose={() => setOcrOpen(false)}
        />
      ) : null}

      {/* Google Drive / Docs import and export (master plan sections 29-31) */}
      {googleOpen ? (
        <IntegrationCenter
          open={googleOpen}
          document={editor}
          onClose={() => setGoogleOpen(false)}
          onImported={(data) => {
            // The converter returns Tiptap JSON, so the import replaces the
            // document body outright. That is a real edit, so it goes through
            // the same revision-saving path as any other change.
            editor?.commands.setContent(data.content);
            if (data.title) setTitle(data.title);
            setRev((r) => r + 1);
          }}
        />
      ) : null}

      {/* New comment composer. The key remounts the dialog for each new thread
          so the draft always starts empty without a reset effect. */}
      <CommentComposer
        key={pendingComment ? `${pendingComment.from}-${pendingComment.quotedText}` : "closed"}
        pending={pendingComment}
        onClose={() => setPendingComment(null)}
        onSubmit={submitComment}
      />
    </div>
  );
}

/**
 * Dialog for writing a new comment thread.
 *
 * Rendered at the page level (not inside the panel) so it can overlay the
 * document without being clipped by the panel's scroll container.
 */
function CommentComposer({ pending, onClose, onSubmit }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const value = body.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSubmit(value);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New comment</DialogTitle>
          <DialogDescription>
            {pending?.quotedText
              ? "Commenting on the selected text."
              : "Comment on the whole document. Use @ to mention someone."}
          </DialogDescription>
        </DialogHeader>

        {pending?.quotedText ? (
          <blockquote className="line-clamp-3 border-l-2 border-amber-300 bg-amber-50/60 py-1 pl-2 text-xs italic text-zinc-600">
            {pending.quotedText}
          </blockquote>
        ) : null}

        <textarea
          autoFocus
          rows={4}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Write a comment... (@name to mention)"
          className="w-full resize-none rounded-md border border-input bg-transparent p-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !body.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            Comment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}