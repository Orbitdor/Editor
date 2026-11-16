"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import PromptDialog from "@/components/PromptDialog";
import { normalizeUrl } from "@/lib/url";

/**
 * Application menu bar (File / Edit / Insert / Format / Tools / Share).
 *
 * A plain popover list is used instead of a dropdown library so the menu can
 * stay keyboard-navigable and close on Escape without extra dependencies.
 */
export default function MenuBar({
  editor,
  onNew,
  onSave,
  onRename,
  onExport,
  onVersions,
  onTags,
  onShare,
  onSaveTemplate,
  canShare = true,
  canEdit = true,
}) {
  const [open, setOpen] = useState(null);
  const [urlDialog, setUrlDialog] = useState(null);
  const barRef = useRef(null);

  // Close on outside click.
  useEffect(() => {
    function onDown(e) {
      if (!barRef.current?.contains(e.target)) setOpen(null);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Close on Escape.
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") setOpen(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const insertTable = () => {
    editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };

  const wordCount = () => {
    const text = editor ? editor.getText() : "";
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
    toast.success(`${words.toLocaleString()} words · ${chars.toLocaleString()} characters`);
  };

  const confirmUrl = (raw) => {
    const isImage = urlDialog === "image";
    const url = normalizeUrl(raw, { image: isImage });
    if (!url) {
      toast.error(
        isImage
          ? "Enter a valid image address, for example https://example.com/photo.png"
          : "Enter a valid web address, for example https://example.com"
      );
      return false;
    }
    if (isImage) editor?.chain().focus().setImage({ src: url }).run();
    else editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    return true;
  };

  // Every item is `{ label, action, shortcut, disabled }`; `null` is a divider.
  const menus = [
    {
      label: "File",
      items: [
        { label: "New document", action: onNew },
        { label: "Save", action: onSave, shortcut: "Ctrl+S", disabled: !canEdit },
        { label: "Rename", action: onRename, disabled: !canEdit },
        null,
        { label: "Download Markdown (.md)", action: () => onExport?.("markdown") },
        { label: "Download HTML (.html)", action: () => onExport?.("html") },
        { label: "Download Plain text (.txt)", action: () => onExport?.("txt") },
        // Rendered on the server, so these take a moment and can fail on a
        // large document; the handler shows the result either way.
        { label: "Download PDF (.pdf)", action: () => onExport?.("pdf") },
        { label: "Download Word (.docx)", action: () => onExport?.("docx") },
        null,
        { label: "Version history", action: onVersions },
        { label: "Tags", action: onTags, disabled: !canShare },
        { label: "Save as template", action: onSaveTemplate, disabled: !canEdit },
        null,
        { label: "Print", action: () => window.print() },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", action: () => editor?.chain().focus().undo().run(), shortcut: "Ctrl+Z", disabled: !canEdit },
        { label: "Redo", action: () => editor?.chain().focus().redo().run(), shortcut: "Ctrl+Y", disabled: !canEdit },
        null,
        {
          label: "Clear formatting",
          action: () => editor?.chain().focus().clearNodes().unsetAllMarks().run(),
          disabled: !canEdit,
        },
        null,
        { label: "Save", action: onSave, disabled: !canEdit },
      ],
    },
    {
      label: "Insert",
      items: [
        { label: "Link", action: () => setUrlDialog("link"), disabled: !canEdit },
        { label: "Image from URL", action: () => setUrlDialog("image"), disabled: !canEdit },
        { label: "Table", action: insertTable, disabled: !canEdit },
        { label: "Horizontal rule", action: () => editor?.chain().focus().setHorizontalRule().run(), disabled: !canEdit },
      ],
    },
    {
      label: "Format",
      items: [
        { label: "Bold", action: () => editor?.chain().focus().toggleBold().run(), shortcut: "Ctrl+B", disabled: !canEdit },
        { label: "Italic", action: () => editor?.chain().focus().toggleItalic().run(), shortcut: "Ctrl+I", disabled: !canEdit },
        { label: "Underline", action: () => editor?.chain().focus().toggleUnderline().run(), shortcut: "Ctrl+U", disabled: !canEdit },
        { label: "Strikethrough", action: () => editor?.chain().focus().toggleStrike().run(), disabled: !canEdit },
      ],
    },
    {
      label: "Share",
      items: [{ label: "Share and manage access", action: onShare }],
    },
    {
      label: "Tools",
      items: [{ label: "Word count", action: wordCount }],
    },
  ];

  return (
    <>
    <nav ref={barRef} className="flex flex-wrap items-center gap-1 border-t border-zinc-100 px-4 py-1">
      {menus.map((menu) => (
        <div key={menu.label} className="relative shrink-0">
          <button
            onClick={() => setOpen(open === menu.label ? null : menu.label)}
            className={`rounded px-2.5 py-1 text-[13px] font-medium transition-colors ${
              open === menu.label
                ? "bg-zinc-100 text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
            }`}
          >
            {menu.label}
          </button>
          {open === menu.label ? (
            <div className="absolute left-0 top-full z-40 mt-0.5 min-w-[210px] rounded-md border border-zinc-200 bg-white py-1 shadow-lg">
              {menu.items.map((item, idx) =>
                item === null ? (
                  <div key={idx} className="my-1 border-t border-zinc-100" />
                ) : (
                  <button
                    key={item.label}
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(null);
                      item.action?.();
                    }}
                    className="flex w-full items-center gap-3 px-4 py-1.5 text-left text-[13px] text-zinc-700 transition-colors hover:bg-zinc-100 disabled:pointer-events-none disabled:text-zinc-300"
                  >
                    <span className="flex-1">{item.label}</span>
                    {item.shortcut ? (
                      <span className="text-[10px] text-zinc-400">{item.shortcut}</span>
                    ) : null}
                  </button>
                )
              )}
            </div>
          ) : null}
        </div>
      ))}
    </nav>

    <PromptDialog
      open={Boolean(urlDialog)}
      onOpenChange={(next) => {
        if (!next) setUrlDialog(null);
      }}
      title={urlDialog === "image" ? "Insert image from URL" : "Insert link"}
      description={
        urlDialog === "image"
          ? "The image stays hosted where it is; the document stores its address."
          : "Paste a web address to link the selected text."
      }
      placeholder={
        urlDialog === "image" ? "https://example.com/photo.png" : "https://example.com"
      }
      submitLabel="Insert"
      onConfirm={confirmUrl}
    />
    </>
  );
}
