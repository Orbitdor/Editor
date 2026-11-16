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
  Unlink,
  Paperclip,
  Image as ImageIcon,
  ImagePlus,
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
  Rows2,
  Columns2,
  Rows3,
  Columns3,
  TableCellsMerge,
  Loader2,
  Ruler,
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
import { normalizeUrl } from "@/lib/url";
import {
  FONT_FAMILIES,
  FONT_SIZES,
  LINE_HEIGHTS,
  COLORS,
  HIGHLIGHT_COLORS,
} from "@/lib/tiptap";
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

function Shortcut({ children }) {
  if (!children) return null;
  return (
    <kbd className="ml-2 rounded border border-border/70 bg-muted px-1 py-px font-mono text-[10px] leading-none text-muted-foreground">
      {children}
    </kbd>
  );
}

function IconBtn({ title, shortcut, active, disabled, onClick, children }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={title}
          aria-pressed={active ? true : undefined}
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
            "h-8 w-8 shrink-0 px-0 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
            active && "bg-blue-50 text-blue-700 hover:bg-blue-100 hover:text-blue-800"
          )}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center">
        {title}
        <Shortcut>{shortcut}</Shortcut>
      </TooltipContent>
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
  width = "w-48",
  ariaLabel,
}) {
  return (
    <DropdownMenu>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={ariaLabel || title}
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              className="h-8 shrink-0 gap-1 px-2 text-zinc-700 hover:bg-zinc-100 data-[state=open]:bg-zinc-100"
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
        {items.map(([val, itemLabel, icon]) => (
          <DropdownMenuItem
            key={String(val)}
            onSelect={() => onSelect?.(val)}
            className="gap-2"
          >
            {icon ? <span className="text-muted-foreground">{icon}</span> : null}
            <span className="flex-1">{itemLabel}</span>
            {String(value ?? "") === String(val ?? "") ? (
              <Check className="size-3.5 text-blue-600" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ColorField({ title, value, items, onPick, onReset, icon, disabled }) {
  return (
    <DropdownMenu>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={title}
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              className="relative h-8 w-8 shrink-0 px-0 text-zinc-600 hover:bg-zinc-100 data-[state=open]:bg-zinc-100"
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
      <DropdownMenuContent align="start" className="w-52">
        <div className="grid grid-cols-5 gap-1.5 p-2">
          {items.map((c) => (
            <button
              key={c.name}
              type="button"
              title={c.name}
              aria-label={c.name}
              onClick={() => onPick(c.value)}
              className={cn(
                "flex size-7 cursor-pointer items-center justify-center rounded-full border transition-transform hover:scale-110",
                value === c.value ? "ring-2 ring-blue-500 ring-offset-1" : ""
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
            aria-label={`Custom ${title.toLowerCase()}`}
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={onReset}
            disabled={!value}
          >
            <RemoveFormatting className="size-3.5" />
            Reset
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TableMenu({ editor, disabled, inTable }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState({ rows: 3, cols: 3 });

  const insert = (rows, cols) => {
    editor?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
    setOpen(false);
  };

  const exec = (command) => () => {
    if (!editor) return;
    editor.chain().focus()[command]().run();
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Table"
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              className={cn(
                "h-8 w-8 shrink-0 px-0 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
                inTable && "bg-blue-50 text-blue-700 hover:bg-blue-100 hover:text-blue-800"
              )}
            >
              <TableIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Table</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-xs">Insert table</DropdownMenuLabel>
        <div className="p-2 pt-0">
          <div
            className="grid grid-cols-8 gap-1"
            onMouseLeave={() => setHover({ rows: 3, cols: 3 })}
          >
            {Array.from({ length: 48 }).map((_, index) => {
              const rows = Math.floor(index / 8) + 1;
              const cols = (index % 8) + 1;
              const selected = rows <= hover.rows && cols <= hover.cols;
              return (
                <button
                  key={index}
                  type="button"
                  aria-label={`Insert ${rows} by ${cols} table`}
                  onMouseEnter={() => setHover({ rows, cols })}
                  onFocus={() => setHover({ rows, cols })}
                  onClick={() => insert(rows, cols)}
                  className={cn(
                    "size-5 rounded-sm border transition-colors",
                    selected
                      ? "border-blue-500 bg-blue-100"
                      : "border-zinc-200 bg-zinc-50 hover:bg-zinc-100"
                  )}
                />
              );
            })}
          </div>
          <div className="mt-1.5 text-center text-xs tabular-nums text-muted-foreground">
            {hover.rows} × {hover.cols} table
          </div>
        </div>

        {inTable ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs">Current table</DropdownMenuLabel>
            <DropdownMenuItem onSelect={exec("addRowBefore")}>
              <Rows3 className="size-4" /> Add row above
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={exec("addRowAfter")}>
              <Rows3 className="size-4" /> Add row below
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={exec("deleteRow")}>
              <Rows2 className="size-4" /> Delete row
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={exec("addColumnBefore")}>
              <Columns3 className="size-4" /> Add column left
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={exec("addColumnAfter")}>
              <Columns3 className="size-4" /> Add column right
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={exec("deleteColumn")}>
              <Columns2 className="size-4" /> Delete column
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={exec("mergeOrSplit")}>
              <TableCellsMerge className="size-4" /> Merge / split cells
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={exec("toggleHeaderRow")}>
              <Rows2 className="size-4" /> Toggle header row
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={exec("toggleHeaderColumn")}>
              <Columns2 className="size-4" /> Toggle header column
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={exec("deleteTable")} className="text-red-600">
              <Eraser className="size-4" /> Delete table
            </DropdownMenuItem>
          </>
        ) : null}
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

function activeAlign(editor) {
  if (!editor) return "left";
  for (const type of ["heading", "paragraph", "blockquote"]) {
    const value = editor.getAttributes(type).textAlign;
    if (value) return value;
  }
  return "left";
}

export default function Toolbar({
  editor,
  mode,
  setMode,
  onAddComment,
  onInsertPageBreak,
  commentsOpen,
  setCommentsOpen,
  showRulers = true,
  onToggleRulers,
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
    const update = () => force();
    editor.on("transaction", update);
    editor.on("selectionUpdate", update);
    return () => {
      editor.off("transaction", update);
      editor.off("selectionUpdate", update);
    };
  }, [editor]);

  const viewOnly = mode === "viewing" || !canEdit;
  const disabled = !editor || viewOnly;

  // The toolbar advertises these shortcuts, so they have to work even though
  // the dialogs are owned by this component rather than by the editor.
  useEffect(() => {
    if (!editor) return;
    const onKeyDown = (event) => {
      if (!editor.isFocused) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      if (event.key.toLowerCase() === "k" && !event.altKey) {
        event.preventDefault();
        if (!disabled) setLinkDialogOpen(true);
        return;
      }
      if (event.altKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        if (!disabled && canComment) onAddComment?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor, disabled, canComment, onAddComment]);

  const block = activeBlock(editor);
  const align = activeAlign(editor);
  const textStyle = editor ? editor.getAttributes("textStyle") : {};
  const highlight = editor ? editor.getAttributes("highlight") : {};
  const fontFamily = textStyle.fontFamily || "";
  const rawFontSize = textStyle.fontSize ? String(Number.parseInt(textStyle.fontSize, 10) || "") : "";
  const lineHeight = textStyle.lineHeight || "";
  const inTable = editor?.isActive("table") ?? false;
  const text = editor ? editor.getText() : "";
  const words = text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  const canUndo = editor ? editor.can().undo() : false;
  const canRedo = editor ? editor.can().redo() : false;

  const focus = () => editor?.chain().focus();

  const run = (fn) => () => {
    if (disabled) return;
    focus()[fn]().run();
  };

  const applyBlock = (val) => {
    if (disabled) return;
    const c = focus();
    if (val === "p") c.setParagraph().run();
    else if (/^h[1-6]$/.test(val)) c.setHeading({ level: Number(val.slice(1)) }).run();
    else if (val === "blockquote") c.setBlockquote().run();
    else if (val === "codeBlock") c.setCodeBlock().run();
  };

  const blockLabel = BLOCK_TYPES.find(([v]) => v === block)?.[1] || "Paragraph";
  const blockIcon = BLOCK_TYPES.find(([v]) => v === block)?.[2] || <Pilcrow className="size-4" />;
  const sizeLabel = rawFontSize ? `${rawFontSize}px` : "Size";
  const fontLabel = fontFamily || "Font";
  // Pre-fills the link dialog so an existing link can be edited or cleared.
  const linkHref = editor ? editor.getAttributes("link").href || "" : "";

  const openLinkDialog = () => {
    if (disabled) return;
    setLinkDialogOpen(true);
  };

  const applyLink = (url) => {
    if (url === "") {
      editor.chain().focus().unsetLink().run();
      return true;
    }
    const href = normalizeUrl(url);
    if (!href) {
      toast.error("Enter a valid web address, for example https://example.com");
      return false;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    return true;
  };

  const openImageDialog = () => {
    if (disabled) return;
    setImageDialogOpen(true);
  };

  const applyImage = (url) => {
    const src = normalizeUrl(url, { image: true });
    if (!src) {
      toast.error("Enter a valid image address, for example https://example.com/photo.png");
      return false;
    }
    editor.chain().focus().setImage({ src }).run();
    return true;
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
          .setImage({
            src: attachmentContentUrl(attachment._id, { inline: true }),
            alt: attachment.name || file.name,
            title: attachment.name || file.name,
          })
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

  const clearFormat = () => {
    if (disabled) return;
    // Comment anchors opt out of `unsetAllMarks`, so this clears cosmetic
    // formatting without detaching an open review thread.
    editor.chain().focus().clearNodes().unsetAllMarks().run();
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className="no-print flex flex-wrap items-center gap-0.5 border-t border-zinc-100 bg-white px-2 py-1">
        <IconBtn
          title="Undo"
          shortcut="Ctrl+Z"
          disabled={disabled || !canUndo}
          onClick={run("undo")}
        >
          <Undo2 className="size-4" />
        </IconBtn>
        <IconBtn
          title="Redo"
          shortcut="Ctrl+Y"
          disabled={disabled || !canRedo}
          onClick={run("redo")}
        >
          <Redo2 className="size-4" />
        </IconBtn>

        <Separator orientation="vertical" className="mx-1.5 h-6! bg-zinc-200" />

        <SelectMenu
          title="Paragraph style"
          ariaLabel="Paragraph style"
          trigger={
            <span className="flex max-w-32 items-center gap-1.5">
              <span className="text-muted-foreground">{blockIcon}</span>
              <span className="truncate text-xs">{blockLabel}</span>
            </span>
          }
          value={block}
          disabled={disabled}
          onSelect={applyBlock}
          width="w-52"
          items={BLOCK_TYPES}
        />
        <SelectMenu
          title="Font family"
          ariaLabel="Font family"
          trigger={<span className="max-w-28 truncate text-xs">{fontLabel}</span>}
          value={fontFamily}
          disabled={disabled}
          onSelect={(v) =>
            v
              ? editor.chain().focus().setFontFamily(v).run()
              : editor.chain().focus().unsetFontFamily().run()
          }
          items={[["", "Default", null], ...FONT_FAMILIES.map((f) => [f, f, null])]}
        />
        <SelectMenu
          title="Font size"
          ariaLabel="Font size"
          trigger={<span className="text-xs tabular-nums">{sizeLabel}</span>}
          value={rawFontSize}
          disabled={disabled}
          onSelect={(v) =>
            v
              ? editor.chain().focus().setFontSize(`${v}px`).run()
              : editor.chain().focus().unsetFontSize().run()
          }
          items={[["", "Default", null], ...FONT_SIZES.map((s) => [String(s), `${s} px`, null])]}
          width="w-36"
        />
        <SelectMenu
          title="Line spacing"
          ariaLabel="Line spacing"
          trigger={
            <span className="inline-flex items-center gap-1 text-xs">
              <MoveVertical className="size-3.5" />
              {lineHeight ? `${lineHeight}×` : "Spacing"}
            </span>
          }
          value={lineHeight}
          disabled={disabled}
          onSelect={setLineSpacing}
          items={[["", "Default", null], ...LINE_HEIGHTS.map((s) => [s, `${s}×`, null])]}
          width="w-36"
        />

        <Separator orientation="vertical" className="mx-1.5 h-6! bg-zinc-200" />

        <IconBtn
          title="Bold"
          shortcut="Ctrl+B"
          active={editor?.isActive("bold")}
          disabled={disabled}
          onClick={run("toggleBold")}
        >
          <Bold className="size-4" />
        </IconBtn>
        <IconBtn
          title="Italic"
          shortcut="Ctrl+I"
          active={editor?.isActive("italic")}
          disabled={disabled}
          onClick={run("toggleItalic")}
        >
          <Italic className="size-4" />
        </IconBtn>
        <IconBtn
          title="Underline"
          shortcut="Ctrl+U"
          active={editor?.isActive("underline")}
          disabled={disabled}
          onClick={run("toggleUnderline")}
        >
          <Underline className="size-4" />
        </IconBtn>
        <IconBtn
          title="Strikethrough"
          shortcut="Ctrl+Shift+X"
          active={editor?.isActive("strike")}
          disabled={disabled}
          onClick={run("toggleStrike")}
        >
          <Strikethrough className="size-4" />
        </IconBtn>
        <ColorField
          title="Text color"
          icon={<Palette className="size-4" />}
          value={textStyle.color}
          items={COLORS}
          disabled={disabled}
          onPick={(v) => {
            if (disabled) return;
            if (v) editor.chain().focus().setColor(v).run();
            else editor.chain().focus().unsetColor().run();
          }}
          onReset={() => editor.chain().focus().unsetColor().run()}
        />
        <ColorField
          title="Highlight color"
          icon={<Highlighter className="size-4" />}
          value={highlight.color}
          items={HIGHLIGHT_COLORS}
          disabled={disabled}
          onPick={(v) => {
            if (disabled) return;
            if (v) editor.chain().focus().setHighlight({ color: v }).run();
            else editor.chain().focus().unsetHighlight().run();
          }}
          onReset={() => editor.chain().focus().unsetHighlight().run()}
        />

        <Separator orientation="vertical" className="mx-1.5 h-6! bg-zinc-200" />

        {ALIGNMENTS.map(([value, title, icon]) => (
          <IconBtn
            key={value}
            title={title}
            active={align === value}
            disabled={disabled}
            onClick={() => {
              if (disabled) return;
              editor.chain().focus().setTextAlign(value).run();
            }}
          >
            {icon}
          </IconBtn>
        ))}

        <Separator orientation="vertical" className="mx-1.5 h-6! bg-zinc-200" />

        <IconBtn
          title="Bulleted list"
          active={editor?.isActive("bulletList")}
          disabled={disabled}
          onClick={run("toggleBulletList")}
        >
          <List className="size-4" />
        </IconBtn>
        <IconBtn
          title="Numbered list"
          active={editor?.isActive("orderedList")}
          disabled={disabled}
          onClick={run("toggleOrderedList")}
        >
          <ListOrdered className="size-4" />
        </IconBtn>
        <IconBtn
          title="Task list"
          active={editor?.isActive("taskList")}
          disabled={disabled}
          onClick={run("toggleTaskList")}
        >
          <ListChecks className="size-4" />
        </IconBtn>

        <Separator orientation="vertical" className="mx-1.5 h-6! bg-zinc-200" />

        <IconBtn
          title={editor?.isActive("link") ? "Edit link" : "Insert link"}
          shortcut="Ctrl+K"
          active={editor?.isActive("link")}
          disabled={disabled}
          onClick={openLinkDialog}
        >
          <Link2 className="size-4" />
        </IconBtn>
        <IconBtn
          title="Upload an image"
          disabled={disabled || uploading || !documentId}
          onClick={pickImage}
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
        </IconBtn>
        <IconBtn
          title="Insert an image from a URL"
          disabled={disabled}
          onClick={openImageDialog}
        >
          <ImageIcon className="size-4" />
        </IconBtn>
        <IconBtn
          title="Attach a file"
          disabled={disabled || uploading || !documentId}
          onClick={pickFile}
        >
          <Paperclip className="size-4" />
        </IconBtn>
        <TableMenu editor={editor} disabled={disabled} inTable={inTable} />
        <IconBtn
          title="Add comment"
          shortcut="Ctrl+Alt+M"
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
                  aria-label="More formatting options"
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  className="h-8 w-8 shrink-0 px-0 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>More</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem
              onSelect={() => editor.chain().focus().toggleCode().run()}
            >
              <Code className="size-4" />
              <span className="flex-1">Inline code</span>
              <span className="text-[10px] text-muted-foreground">Ctrl+E</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => editor.chain().focus().toggleCodeBlock().run()}
            >
              <Code className="size-4" /> Code block
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => editor.chain().focus().toggleBlockquote().run()}
            >
              <TextQuote className="size-4" /> Blockquote
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => editor.chain().focus().setHorizontalRule().run()}
            >
              <SeparatorHorizontal className="size-4" /> Horizontal rule
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onInsertPageBreak?.()}>
              <SeparatorHorizontal className="size-4" />
              <span className="flex-1">Page break</span>
              <span className="text-[10px] text-muted-foreground">Ctrl+Enter</span>
            </DropdownMenuItem>
            {editor?.isActive("link") ? (
              <DropdownMenuItem onSelect={() => editor.chain().focus().unsetLink().run()}>
                <Unlink className="size-4" /> Remove link
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            {onToggleRulers ? (
              <DropdownMenuItem onSelect={onToggleRulers}>
                <Ruler className="size-4" />
                <span className="flex-1">{showRulers ? "Hide rulers" : "Show rulers"}</span>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={clearFormat}>
              <Eraser className="size-4" /> Clear formatting
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => window.print()}>
              <Printer className="size-4" /> Print
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />

        <span className="hidden text-[11px] tabular-nums text-muted-foreground lg:inline">
          {text.length.toLocaleString()} chars · {words.toLocaleString()} words
        </span>
        {/* Users without edit rights get a read-only indicator instead of a toggle.
            `canEdit === null` means the caller's access has not resolved yet, so
            both branches are withheld -- rendering the badge on the first frame
            would flash "Read only" at users who are about to be able to edit. */}
        {canEdit === null ? null : canEdit ? (
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
          and looked like a browser alert inside an otherwise custom editor.
          Returning `false` from onConfirm keeps the dialog open with the bad
          value so the user can correct it. */}
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
          inline-image allow-list, so an unsupported file is filtered before it is
          chosen rather than after a round trip. */}
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
        accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.txt,.csv,.zip,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp3,.m4a,.wav,.weba"
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
