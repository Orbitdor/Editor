"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import {
  Undo2,
  Redo2,
  Printer,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Palette,
  Highlighter,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  List,
  ListOrdered,
  ListChecks,
  Code,
  Link2,
  Paperclip,
  Image as ImageIcon,
  Table as TableIcon,
  MessageSquarePlus,
  SeparatorHorizontal,
  Eraser,
  ChevronDown,
  Check,
  Eye,
  Pencil,
  Pilcrow,
  Type,
  TextQuote,
  MoreHorizontal,
  MoveVertical,
  RemoveFormatting,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import PromptDialog from "@/components/PromptDialog";
import { cn } from "@/lib/utils";
import { FONT_FAMILIES, FONT_SIZES, LINE_HEIGHTS, COLORS } from "@/lib/tiptap";
import {
  attachmentContentUrl,
  uploadAttachment,
  uploadAttachmentImage,
} from "@/lib/api";
import { toast } from "sonner";

const BLOCK_TYPES = [
  ["p", "Paragraph", <Pilcrow key="p" className="size-4" />],
  ["h1", "Heading 1", <Type key="h1" className="size-4" />],
  ["h2", "Heading 2", <Type key="h2" className="size-4" />],
  ["h3", "Heading 3", <Type key="h3" className="size-4" />],
  ["h4", "Heading 4", <Type key="h4" className="size-4" />],
  ["h5", "Heading 5", <Type key="h5" className="size-4" />],
  ["h6", "Heading 6", <Type key="h6" className="size-4" />],
  ["blockquote", "Blockquote", <TextQuote key="bq" className="size-4" />],
  ["codeBlock", "Code block", <Code key="cb" className="size-4" />],
];

const ALIGNMENTS = [
  ["left", "Align left", <AlignLeft key="al" className="size-4" />],
  ["center", "Align center", <AlignCenter key="ac" className="size-4" />],
  ["right", "Align right", <AlignRight key="ar" className="size-4" />],
  ["justify", "Justify", <AlignJustify key="aj" className="size-4" />],
];

function IconBtn({ title, active, disabled, onClick, children }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={title}
          data-active={active ? "true" : "false"}
          disabled={disabled}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.preventDefault();
            onClick?.();
          }}
          className={cn(
            "h-8 w-8 px-0",
            active && "bg-accent text-accent-foreground"
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

function SelectMenu({
  title,
  trigger,
  label,
  disabled,
  items,
  value,
  onSelect,
  width = "w-44",
}) {
  return (
    <DropdownMenu>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              className="h-8 gap-1 data-[state=open]:bg-accent"
            >
              {trigger}
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className={cn(width, "max-h-80 overflow-auto")}>
        {label ? <DropdownMenuLabel className="text-xs">{label}</DropdownMenuLabel> : null}
        {items.map(([val, itemLabel, icon], i) => (
          <DropdownMenuItem
            key={String(val)}
            onSelect={() => onSelect?.(val)}
            className="gap-2"
          >
            {icon ? <span className="text-muted-foreground">{icon}</span> : null}
            <span className="flex-1">{itemLabel}</span>
            {value === val ? <Check className="size-3.5 text-primary" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ColorField({ title, value, onPick, onReset, icon, active }) {
  return (
    <DropdownMenu>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={title}
              onMouseDown={(e) => e.preventDefault()}
              className="relative h-8 w-8 px-0 data-[state=open]:bg-accent"
            >
              {icon}
              <span
                className="absolute inset-x-1.5 bottom-1.5 h-[3px] rounded-sm"
                style={{ background: value || "#334155" }}
              />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-44">
        <div className="grid grid-cols-5 gap-1 p-2">
          {COLORS.map((c) => (
            <button
              key={c.name}
              type="button"
              title={c.name}
              onClick={() => onPick(c.value)}
              className={cn(
                "size-7 cursor-pointer rounded-full border flex items-center justify-center transition-transform hover:scale-110",
                active === c.value ? "ring-2 ring-blue-500 ring-offset-1" : ""
              )}
              style={{ background: c.value || "#ffffff" }}
            >
              {!c.value ? <span className="text-[10px] text-muted-foreground">∅</span> : null}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t px-2 py-1.5">
          <input
            type="color"
            defaultValue={value || "#000000"}
            onChange={(e) => onPick(e.target.value)}
            className="h-6 w-8 cursor-pointer rounded border border-input bg-transparent p-0"
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={onReset}
          >
            <RemoveFormatting className="size-3.5" />
            Reset
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function activeBlock(editor) {
  if (!editor) return "p";
  for (let lv = 1; lv <= 6; lv++) {
    if (editor.isActive("heading", { level: lv })) return `h${lv}`;
  }
  if (editor.isActive("blockquote")) return "blockquote";
  if (editor.isActive("codeBlock")) return "codeBlock";
  return "p";
}

export default function Toolbar({
  editor,
  mode,
  setMode,
  onAddComment,
  onInsertPageBreak,
  commentsOpen,
  setCommentsOpen,
  canEdit = true,
  canComment = true,
  documentId = null,
}) {
  const [, force] = useReducer((x) => x + 1, 0);
  // Hidden pickers for the two attach paths: an image becomes an inline figure, a
  // file becomes an attachment card. Kept in refs so the buttons can just click
  // them, and the same input is reused after each selection.
  const imagePicker = useRef(null);
  const filePicker = useRef(null);
  const [uploading, setUploading] = useState(false);
  // The two "type a URL" actions open a dialog instead of window.prompt.
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [imageDialogOpen, setImageDialogOpen] = useState(false);

  useEffect(() => {
    if (!editor) return;
    editor.on("transaction", force);
    editor.on("selectionUpdate", force);
    return () => {
      editor.off("transaction", force);
      editor.off("selectionUpdate", force);
    };
  }, [editor]);

  const viewOnly = mode === "viewing" || !canEdit;
  const disabled = !editor || viewOnly;

  const block = activeBlock(editor);
  const textStyle = editor ? editor.getAttributes("textStyle") : {};
  const highlight = editor ? editor.getAttributes("highlight") : {};
  const fontFamily = textStyle.fontFamily || "";
  const fontSize = textStyle.fontSize ? Number.parseInt(textStyle.fontSize, 10) || "" : "";
  const lineHeight = textStyle.lineHeight || "";
  const inTable = editor?.can().addRowBefore() ?? false;
  const text = editor ? editor.getText() : "";
  const words = text.trim().split(/\s+/).filter(Boolean).length;

  const focus = () => editor?.chain().focus();

  const run = (fn) => () => {
    if (disabled) return;
    focus()[fn]().run();
  };

  const applyBlock = (val) => {
    if (disabled) return;
    const c = focus();
    if (val === "p") c.setParagraph().run();
    else if (/^h[1-6]$/.test(val)) c.toggleHeading({ level: Number(val.slice(1)) }).run();
    else if (val === "blockquote") c.toggleBlockquote().run();
    else if (val === "codeBlock") c.toggleCodeBlock().run();
  };

  const blockLabel = (BLOCK_TYPES.find(([v]) => v === block)?.[1]) || "Paragraph";
  const sizeLabel = fontSize ? `Size · ${fontSize}` : "Size";
  const fontLabel = fontFamily || "Font";
  // Pre-fills the link dialog so an existing link can be edited or cleared.
  const linkHref = editor && !disabled ? editor.getAttributes("link").href || "" : "";

  const insertLink = () => {
    if (disabled) return;
    setLinkDialogOpen(true);
  };

  const applyLink = (url) => {
    if (url === "") editor.chain().focus().unsetLink().run();
    else editor.chain().focus().setLink({ href: url }).run();
  };

  const insertImage = () => {
    if (disabled) return;
    setImageDialogOpen(true);
  };

  const applyImage = (url) => {
    if (url) editor.chain().focus().setImage({ src: url }).run();
  };

  /**
   * Upload a picked file and drop it into the document.
   *
   * The server returns an id rather than a permanent URL, so what lands in the
   * shared Yjs document is a reference every collaborator can resolve but nobody
   * can read without access to this document.
   */
  const handleUpload = async (file, kind) => {
    if (disabled || !file || !documentId) return;
    setUploading(true);
    try {
      if (kind === "image") {
        const res = await uploadAttachmentImage(documentId, file);
        const attachment = res.attachment;
        editor
          .chain()
          .focus()
          .setImage({ src: attachmentContentUrl(attachment._id, { inline: true }) })
          .run();
      } else {
        const res = await uploadAttachment(documentId, file);
        const attachment = res.attachment;
        editor
          .chain()
          .focus()
          .insertAttachment({
            attachmentId: attachment._id,
            name: attachment.name,
            mime: attachment.mime,
            bytes: attachment.bytes,
          })
          .run();
      }
      toast.success(`${file.name} attached`);
    } catch (err) {
      // The server speaks in plain messages ("That file type is not supported"),
      // which are clearer than anything invented here.
      toast.error(err.message || "That file could not be attached");
    } finally {
      setUploading(false);
    }
  };

  const pickImage = () => {
    if (disabled || !documentId) return;
    imagePicker.current?.click();
  };

  const pickFile = () => {
    if (disabled || !documentId) return;
    filePicker.current?.click();
  };

  const setLineSpacing = (v) => {
    if (disabled) return;
    if (v) editor.chain().focus().setLineHeight(v).run();
    else editor.chain().focus().unsetLineHeight().run();
  };

  const applyTable = (v) => {
    if (disabled || !editor) return;
    const c = editor.chain().focus();
    const actions = {
      insertTable: () => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
      addRowBefore: () => c.addRowBefore(),
      addRowAfter: () => c.addRowAfter(),
      addColumnBefore: () => c.addColumnBefore(),
      addColumnAfter: () => c.addColumnAfter(),
      toggleHeaderRow: () => c.toggleHeaderRow(),
      deleteRow: () => c.deleteRow(),
      deleteColumn: () => c.deleteColumn(),
    };
    actions[v]?.();
  };

  const clearFormat = () => {
    if (disabled) return;
    editor.chain().focus().clearNodes().unsetAllMarks().run();
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex flex-wrap items-center gap-0.5 border-t border-zinc-100 bg-white px-2 py-1">
        <IconBtn title="Undo (Ctrl+Z)" disabled={disabled} onClick={run("undo")}>
          <Undo2 className="size-4" />
        </IconBtn>
        <IconBtn title="Redo (Ctrl+Y)" disabled={disabled} onClick={run("redo")}>
          <Redo2 className="size-4" />
        </IconBtn>
        <IconBtn title="Print" onClick={() => window.print()}>
          <Printer className="size-4" />
        </IconBtn>

        <Separator orientation="vertical" className="mx-1.5 h-6! bg-zinc-200" />

        <SelectMenu
          title="Paragraph styles"
          trigger={<span className="max-w-28 truncate text-xs">{blockLabel}</span>}
          value={block}
          disabled={disabled}
          onSelect={applyBlock}
          width="w-48"
          items={BLOCK_TYPES}
        />
        <SelectMenu
          title="Font"
          trigger={<span className="mx-0.5 text-xs">{fontLabel}</span>}
          value={fontFamily}
          disabled={disabled}
          onSelect={(v) =>
            v ? editor.chain().focus().setFontFamily(v).run() : editor.chain().focus().unsetFontFamily().run()
          }
          items={[["", "Default", null], ...FONT_FAMILIES.map((f) => [f, f, null])]}
        />
        <SelectMenu
          title="Font size"
          trigger={<span className="mx-0.5 text-xs">{sizeLabel}</span>}
          value={fontSize}
          disabled={disabled}
          onSelect={(v) =>
            v ? editor.chain().focus().setFontSize(`${v}px`).run() : editor.chain().focus().unsetFontSize().run()
          }
          items={[["", "Default", null], ...FONT_SIZES.map((s) => [String(s), `${s}`, null])]}
        />
        <SelectMenu
          title="Line spacing"
          trigger={
            <span className="mx-0.5 inline-flex items-center gap-1 text-xs">
              <MoveVertical className="size-3.5" />
              Spacing
            </span>
          }
          value={lineHeight}
          disabled={disabled}
          onSelect={setLineSpacing}
          items={[["", "Default", null], ...LINE_HEIGHTS.map((s) => [s, `${s}x`, null])]}
        />

        <Separator orientation="vertical" className="mx-1.5 h-6! bg-zinc-200" />

        <IconBtn title="Bold (Ctrl+B)" active={editor?.isActive("bold")} disabled={disabled} onClick={run("toggleBold")}>
          <Bold className="size-4" />
        </IconBtn>
        <IconBtn title="Italic (Ctrl+I)" active={editor?.isActive("italic")} disabled={disabled} onClick={run("toggleItalic")}>
          <Italic className="size-4" />
        </IconBtn>
        <IconBtn title="Underline (Ctrl+U)" active={editor?.isActive("underline")} disabled={disabled} onClick={run("toggleUnderline")}>
          <Underline className="size-4" />
        </IconBtn>
        <IconBtn title="Strikethrough" active={editor?.isActive("strike")} disabled={disabled} onClick={run("toggleStrike")}>
          <Strikethrough className="size-4" />
        </IconBtn>
        <ColorField
          title="Text color"
          value={textStyle.color}
          active={textStyle.color}
          icon={<Palette className="size-4" />}
          onPick={(v) => (v ? editor.chain().focus().setColor(v).run() : editor.chain().focus().unsetColor().run())}
          onReset={() => editor.chain().focus().unsetColor().run()}
        />
        <ColorField
          title="Highlight color"
          value={highlight.color}
          active={highlight.color}
          icon={<Highlighter className="size-4" />}
          onPick={(v) => (v ? editor.chain().focus().setHighlight({ color: v }).run() : editor.chain().focus().unsetHighlight().run())}
          onReset={() => editor.chain().focus().unsetHighlight().run()}
        />

        <Separator orientation="vertical" className="mx-1.5 h-6! bg-zinc-200" />

        <SelectMenu
          title="Alignment"
          trigger={<AlignLeft className="size-4" />}
          disabled={disabled}
          onSelect={(v) => editor.chain().focus().setTextAlign(v).run()}
          items={ALIGNMENTS}
          width="w-40"
        />
        <IconBtn title="Bulleted list" active={editor?.isActive("bulletList")} disabled={disabled} onClick={run("toggleBulletList")}>
          <List className="size-4" />
        </IconBtn>
        <IconBtn title="Numbered list" active={editor?.isActive("orderedList")} disabled={disabled} onClick={run("toggleOrderedList")}>
          <ListOrdered className="size-4" />
        </IconBtn>
        <IconBtn title="Task list" active={editor?.isActive("taskList")} disabled={disabled} onClick={run("toggleTaskList")}>
          <ListChecks className="size-4" />
        </IconBtn>

        <Separator orientation="vertical" className="mx-1.5 h-6! bg-zinc-200" />

        <IconBtn title="Insert link" active={editor?.isActive("link")} disabled={disabled} onClick={insertLink}>
          <Link2 className="size-4" />
        </IconBtn>
        <IconBtn title="Upload an image" disabled={disabled || uploading} onClick={pickImage}>
          <ImageIcon className="size-4" />
        </IconBtn>
        <IconBtn
          title="Attach a file"
          disabled={disabled || uploading || !documentId}
          onClick={pickFile}
        >
          <Paperclip className="size-4" />
        </IconBtn>
        <IconBtn
          title="Insert an image from a URL"
          disabled={disabled}
          onClick={insertImage}
        >
          <Link2 className="size-4" />
        </IconBtn>
        <DropdownMenu>
          <Tooltip delayDuration={150}>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Table"
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  className={cn("h-8 w-8 px-0", inTable && "bg-accent text-accent-foreground")}
                >
                  <TableIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Table</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-44">
            <DropdownMenuLabel className="text-xs">Table</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => applyTable("insertTable")}>
              <TableIcon className="size-4" /> Insert 3×3 table
            </DropdownMenuItem>
            {inTable ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => applyTable("addRowAfter")}>
                  <List className="size-4" /> Add row below
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => applyTable("addColumnAfter")}>
                  <List className="size-4" /> Add column right
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => applyTable("toggleHeaderRow")}>
                  <List className="size-4" /> Toggle header row
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => applyTable("deleteRow")}>
                  <List className="size-4" /> Delete row
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => applyTable("deleteColumn")}>
                  <List className="size-4" /> Delete column
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <IconBtn
          title="Add comment"
          active={commentsOpen}
          disabled={!editor || !canComment}
          onClick={onAddComment}
        >
          <MessageSquarePlus className="size-4" />
        </IconBtn>

        <DropdownMenu>
          <Tooltip delayDuration={150}>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="More"
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  className="h-8 w-8 px-0"
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>More</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem onSelect={() => editor.chain().focus().toggleCodeBlock().run()}>
              <Code className="size-4" /> Code block
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => editor.chain().focus().setHorizontalRule().run()}>
              <SeparatorHorizontal className="size-4" /> Horizontal rule
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onInsertPageBreak?.()}>
              <SeparatorHorizontal className="size-4" /> Page break
              <span className="ml-auto text-[10px] text-muted-foreground">Ctrl+Enter</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={clearFormat}>
              <Eraser className="size-4" /> Clear formatting
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />

        <span className="hidden text-[11px] tabular-nums text-muted-foreground md:inline">
          {text.length.toLocaleString()} chars · {words.toLocaleString()} words
        </span>
        {/* Users without edit rights get a read-only indicator instead of a toggle. */}
        {canEdit ? (
          <IconBtn
            title={viewOnly ? "Switch to editing" : "Switch to viewing"}
            active={viewOnly}
            onClick={() => setMode(viewOnly ? "editing" : "viewing")}
          >
            {viewOnly ? <Pencil className="size-4" /> : <Eye className="size-4" />}
          </IconBtn>
        ) : (
          <span className="flex items-center gap-1 rounded bg-zinc-100 px-2 py-1 text-[11px] text-zinc-500">
            <Eye className="size-3.5" />
            Read only
          </span>
        )}
      </div>

      {/* Styled stand-ins for window.prompt. The native dialog blocked the tab
          and looked like a browser alert inside an otherwise custom editor. */}
      <PromptDialog
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        title={linkHref ? "Edit link" : "Insert link"}
        description="Paste a web address. Clear the field to remove the link."
        placeholder="https://example.com"
        defaultValue={linkHref}
        submitLabel={linkHref ? "Update" : "Insert"}
        onConfirm={applyLink}
      />
      <PromptDialog
        open={imageDialogOpen}
        onOpenChange={setImageDialogOpen}
        title="Insert image from URL"
        description="The image stays hosted where it is; the document stores its address."
        placeholder="https://example.com/photo.png"
        submitLabel="Insert"
        onConfirm={applyImage}
      />

      {/* Hidden pickers for the two attach paths. `accept` mirrors the server's
          allow-list, so an unsupported file is filtered before it is chosen
          rather than after a round trip. */}
      <input
        ref={imagePicker}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset first, so picking the same file twice in a row still fires.
          e.target.value = "";
          if (file) handleUpload(file, "image");
        }}
      />
      <input
        ref={filePicker}
        type="file"
        accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.txt,.csv,.zip,.png,.jpg,.jpeg,.gif,.webp,.mp3,.m4a,.wav,.weba"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) handleUpload(file, "file");
        }}
      />
    </TooltipProvider>
  );
}