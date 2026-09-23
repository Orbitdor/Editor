"use client";

import { useEffect, useRef, useState } from "react";

export default function MenuBar({ onNew, onSave, onRename }) {
  const [open, setOpen] = useState(null);
  const barRef = useRef(null);

  useEffect(() => {
    function onDown(e) {
      if (!barRef.current?.contains(e.target)) setOpen(null);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const menus = [
    {
      label: "File",
      items: [
        { label: "New document", action: onNew },
        { label: "Save", action: onSave },
        { label: "Rename", action: onRename },
        null,
        { label: "Print", action: null },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", action: null },
        { label: "Redo", action: null },
        null,
        { label: "Save", action: onSave },
      ],
    },
    {
      label: "View",
      items: [{ label: "Show rulers", action: null }],
    },
    {
      label: "Insert",
      items: [
        { label: "Image", action: null },
        { label: "Table", action: null },
      ],
    },
    {
      label: "Format",
      items: [
        { label: "Bold", action: null },
        { label: "Italic", action: null },
        { label: "Underline", action: null },
      ],
    },
    {
      label: "Tools",
      items: [{ label: "Word count", action: null }],
    },
    {
      label: "Extensions",
      items: [{ label: "Add-ons", action: null }],
    },
    {
      label: "Help",
      items: [
        { label: "Keyboard shortcuts", action: null },
        null,
        { label: "About Doc Editor", action: null },
      ],
    },
  ];

  return (
    <nav
      ref={barRef}
      className="flex flex-wrap items-center gap-1 border-t border-zinc-100 px-4 py-1"
    >
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
          {open === menu.label && (
            <div className="absolute left-0 top-full z-30 mt-0.5 min-w-[190px] rounded-md border border-zinc-200 bg-white py-1 shadow-lg">
              {menu.items.map((item, idx) =>
                item === null ? (
                  <div key={idx} className="my-1 border-t border-zinc-100" />
                ) : (
                  <button
                    key={item.label}
                    onClick={() => {
                      setOpen(null);
                      item.action?.();
                    }}
                    className="flex w-full items-center px-4 py-1.5 text-left text-[13px] text-zinc-700 transition-colors hover:bg-zinc-100"
                  >
                    {item.label}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}