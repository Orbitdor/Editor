"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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

  const insertImage = () => {
    const url = window.prompt("Image URL:", "https://");
    if (url) editor?.chain().focus().setImage({ src: url }).run();
  };

  const insertTable = () => {
    editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };

  const wordCount = () => {
    const chars = editor ? editor.getText().length : 0;
    const words = chars ? chars.trim().split(/\s+/).filter(Boolean).length : 0;
    toast.success(`${words.toLocaleString()} words · ${chars.toLocaleString()} characters`);
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
        { label: "Image", action: insertImage, disabled: !canEdit },
        { label: "Table", action: insertTable, disabled: !canEdit },
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
  );
}
