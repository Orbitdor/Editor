"use client";

import { useEffect, useRef, useState } from "react";
import {
  Undo2,
  Redo2,
  Printer,
  Search,
  SpellCheck,
  Paintbrush,
  Link2,
  MessageSquarePlus,
  Image,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  ListChecks,
  List,
  ListOrdered,
  MoreHorizontal,
  MoveVertical,
  ChevronDown,
  Check,
  Pencil,
  TextCursorInput,
  Eye,
  SeparatorHorizontal,
} from "lucide-react";

const FONTS = [
  "Arial",
  "Calibri",
  "Times New Roman",
  "Georgia",
  "Verdana",
  "Courier New",
  "Tahoma",
  "Trebuchet MS",
  "Comic Sans MS",
];

const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

const STYLES = [
  ["Normal text", "P"],
  ["Title", "H1"],
  ["Subtitle", "H2"],
  ["Heading 1", "H3"],
  ["Heading 2", "H4"],
  ["Heading 3", "H5"],
];

const SPACINGS = ["1", "1.15", "1.5", "1.75", "2", "2.5", "3"];

const ZOOMS = [50, 75, 90, 100, 110, 125, 150, 200];

const MODES = [
  ["editing", "Editing"],
  ["suggesting", "Suggesting"],
  ["viewing", "Viewing"],
];

const ICONS = {
  undo: <Undo2 className="h-4 w-4" />,
  redo: <Redo2 className="h-4 w-4" />,
  print: <Printer className="h-4 w-4" />,
  search: <Search className="h-4 w-4" />,
  spell: <SpellCheck className="h-4 w-4" />,
  brush: <Paintbrush className="h-4 w-4" />,
  link: <Link2 className="h-4 w-4" />,
  comment: <MessageSquarePlus className="h-4 w-4" />,
  image: <Image className="h-4 w-4" />,
  alignLeft: <AlignLeft className="h-4 w-4" />,
  alignCenter: <AlignCenter className="h-4 w-4" />,
  alignRight: <AlignRight className="h-4 w-4" />,
  alignJustify: <AlignJustify className="h-4 w-4" />,
  spacing: <MoveVertical className="h-4 w-4" />,
  checklist: <ListChecks className="h-4 w-4" />,
  bullet: <List className="h-4 w-4" />,
  number: <ListOrdered className="h-4 w-4" />,
  more: <MoreHorizontal className="h-4 w-4" />,
  pageBreak: <SeparatorHorizontal className="h-4 w-4" />,
};

function Select({
  value,
  onChange,
  options,
  className = "",
  title,
  emptyLabel,
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange && onChange(e.target.value)}
      title={title}
      className={`h-8 rounded-md border border-zinc-300 bg-white px-1.5 text-xs text-zinc-800 outline-none focus:border-blue-400 ${className}`}
    >
      {emptyLabel ? <option value="">{emptyLabel}</option> : null}
      {options.map((o) => {
        const val = Array.isArray(o) ? o[0] : o;
        const label = Array.isArray(o) ? o[1] : o;
        return (
          <option key={val} value={val}>
            {label}
          </option>
        );
      })}
    </select>
  );
}

function Btn({
  onClick,
  onMouseDown,
  active,
  title,
  children,
  disabled,
  className = "",
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMouseDown && onMouseDown(e);
      }}
      onClick={(e) => {
        e.preventDefault();
        onClick && onClick(e);
      }}
      className={`flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? "bg-blue-100 text-blue-700 ring-1 ring-blue-300" : ""
      } ${className}`}
    >
      {children}
    </button>
  );
}

const Divider = () => <div className="mx-1 h-6 w-px shrink-0 bg-zinc-200" />;

const MODE_ICONS = {
  editing: <Pencil className="h-4 w-4" />,
  suggesting: <TextCursorInput className="h-4 w-4" />,
  viewing: <Eye className="h-4 w-4" />,
};

function IconDropdown({
  title,
  currentIcon,
  items,
  value,
  onSelect,
  disabled,
  align = "left",
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        title={title}
        disabled={disabled}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 items-center gap-0.5 rounded-md px-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {currentIcon}
        <ChevronDown className="h-3 w-3 text-zinc-400" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={`absolute top-full z-20 mt-1 min-w-44 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            {items.map(([val, label, ic]) => (
              <button
                key={val}
                type="button"
                title={label}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={() => {
                  onSelect && onSelect(val);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-100 ${
                  value === val ? "text-blue-700" : "text-zinc-700"
                }`}
              >
                <span className="text-zinc-600">{ic}</span>
                <span className="font-medium">{label}</span>
                {value === val ? (
                  <Check className="ml-auto h-3.5 w-3.5 text-blue-600" />
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function Toolbar({
  editorRef,
  mode,
  setMode,
  zoom,
  setZoom,
  onEdit,
  onAddComment,
  onPageBreak,
  showComments,
  commentsOpen,
  setCommentsOpen,
}) {
  const [sel, setSel] = useState({});
  const [paintActive, setPaintActive] = useState(false);
  const [spell, setSpell] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const paintRef = useRef(null);
  const findRef = useRef(null);

  useEffect(() => {
    const update = () => {
      const d = document;
      setSel({
        bold: d.queryCommandState("bold"),
        italic: d.queryCommandState("italic"),
        underline: d.queryCommandState("underline"),
        formatBlock: String(d.queryCommandValue("formatBlock") || "P").toUpperCase().replace(/^<|>$/g, ""),
        alignLeft: d.queryCommandState("justifyLeft"),
        alignCenter: d.queryCommandState("justifyCenter"),
        alignRight: d.queryCommandState("justifyRight"),
        alignFull: d.queryCommandState("justifyFull"),
        ol: d.queryCommandState("insertOrderedList"),
        ul: d.queryCommandState("insertUnorderedList"),
        fontName: d.queryCommandValue("fontName"),
        fontSize: d.queryCommandValue("fontSize"),
      });
    };
    update();
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  useEffect(() => {
    if (editorRef.current) editorRef.current.spellcheck = spell;
  }, [spell, editorRef]);

  useEffect(() => {
    if (!paintActive) return;
    const apply = () => {
      const p = paintRef.current;
      if (!p) return;
      const el = editorRef.current;
      if (el) el.focus();
      const d = document;
      if (p.bold) d.execCommand("bold", false);
      if (p.italic) d.execCommand("italic", false);
      if (p.underline) d.execCommand("underline", false);
      if (p.color) {
        d.execCommand("styleWithCSS", false, "true");
        d.execCommand("foreColor", false, p.color);
      }
      if (p.hilite) {
        d.execCommand("styleWithCSS", false, "true");
        d.execCommand("hiliteColor", false, p.hilite);
      }
      if (p.font) d.execCommand("fontName", false, p.font);
      onEdit && onEdit();
      paintRef.current = null;
      setPaintActive(false);
    };
    document.addEventListener("mouseup", apply);
    return () => document.removeEventListener("mouseup", apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paintActive]);

  const exec = (cmd, val) => {
    const el = editorRef.current;
    if (!el) return;
    if (mode === "viewing") return;
    el.focus();
    if (cmd === "foreColor" || cmd === "hiliteColor") {
      document.execCommand("styleWithCSS", false, "true");
    }
    document.execCommand(cmd, false, val);
    onEdit && onEdit();
  };

  const applyFontSize = (px) => {
    const el = editorRef.current;
    if (!el || mode === "viewing") return;
    el.focus();
    const prev = [...document.querySelectorAll("font[size]")];
    document.execCommand("fontSize", false, "7");
    const added = [
      ...document.querySelectorAll("font[size]"),
    ].filter((f) => !prev.includes(f));
    added.forEach((f) => {
      const span = document.createElement("span");
      span.style.fontSize = `${px}pt`;
      span.innerHTML = f.innerHTML;
      f.replaceWith(span);
    });
    [...document.querySelectorAll("font[size]")].forEach((f) => f.removeAttribute("size"));
    onEdit && onEdit();
  };

  const applyLineSpacing = (val) => {
    const el = editorRef.current;
    if (!el || mode === "viewing") return;
    el.focus();
    const s = window.getSelection();
    if (!s.rangeCount) return;
    let node = s.getRangeAt(0).startContainer;
    if (node.nodeType === 3) node = node.parentElement;
    let block = node.closest
      ? node.closest("p,h1,h2,h3,h4,h5,h6,li,div,blockquote")
      : null;
    block = block || node;
    if (block && block.nodeType === 1) block.style.lineHeight = val;
    onEdit && onEdit();
  };

  const togglePaint = () => {
    if (mode === "viewing") return;
    if (paintActive) {
      paintRef.current = null;
      setPaintActive(false);
      return;
    }
    const d = document;
    paintRef.current = {
      bold: d.queryCommandState("bold") ? "bold" : "",
      italic: d.queryCommandState("italic") ? "italic" : "",
      underline: d.queryCommandState("underline") ? "underline" : "",
      color: d.queryCommandValue("foreColor") || "",
      hilite: d.queryCommandValue("hiliteColor") || "",
      font: d.queryCommandValue("fontName") || "",
    };
    setPaintActive(
      !!(paintRef.current.bold || paintRef.current.italic || paintRef.current.underline || paintRef.current.color || paintRef.current.hilite || paintRef.current.font)
    );
  };

  const doFind = () => {
    if (!findQuery || mode === "viewing") return;
    const el = editorRef.current;
    if (el) el.focus();
    window.find(findQuery, false, false, true);
  };

  const closeFind = () => {
    setFindOpen(false);
    setFindQuery("");
  };

  const insertChecklist = () => {
    const el = editorRef.current;
    if (!el || mode === "viewing") return;
    el.focus();
    const html =
      '<div style="display:flex;align-items:center;gap:8px;margin:2px 0"><input type="checkbox" tabindex="-1" style="width:14px;height:14px;flex:none">&nbsp;</div>';
    document.execCommand("insertHTML", false, html);
    onEdit && onEdit();
  };

  const activeAlign =
    (sel.alignCenter && "alignCenter") ||
    (sel.alignRight && "alignRight") ||
    (sel.alignFull && "alignFull") ||
    (sel.alignLeft && "alignLeft") ||
    "";

  const selectCls = active =>
    `h-8 rounded-md border ${
      active ? "border-blue-400 bg-blue-50" : "border-zinc-300 bg-white"
    } px-1.5 text-xs text-zinc-800 outline-none focus:border-blue-400`;

  return (
    <div className="relative border-b border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center gap-x-0.5 gap-y-0.5 px-3 py-1.5">
        <Btn title="Undo (Ctrl+Z)" disabled={mode === "viewing"} onClick={() => exec("undo")}>
          {ICONS.undo}
        </Btn>
        <Btn title="Redo (Ctrl+Y)" disabled={mode === "viewing"} onClick={() => exec("redo")}>
          {ICONS.redo}
        </Btn>
        <Btn title="Print" onClick={() => window.print()}>
          {ICONS.print}
        </Btn>
        <Btn title="Search" active={findOpen} onClick={() => (findOpen ? closeFind() : setFindOpen(true))}>
          {ICONS.search}
        </Btn>
        <Btn
          title="Spelling and grammar check"
          active={spell}
          disabled={mode === "viewing"}
          onClick={() => setSpell((v) => !v)}
        >
          {ICONS.spell}
        </Btn>
        <Btn title="Paint format" active={paintActive} disabled={mode === "viewing"} onClick={togglePaint}>
          {ICONS.brush}
        </Btn>
        <Divider />
        <Select
          value={String(zoom)}
          title="Zoom"
          onChange={(v) => setZoom(Number(v))}
          options={ZOOMS.map((z) => [String(z), `${z}%`])}
          className="w-16"
        />
        <Divider />

        <Select
          value={sel.formatBlock === "P" ? "P" : sel.formatBlock}
          title="Styles"
          options={STYLES.map(([tag, label]) => [
            tag,
            label,
          ])}
          emptyLabel="Paragraph styles"
          className="w-32"
          onChange={(val) =>
            exec("formatBlock", val === "P" ? "P" : val)
          }
        />
        <Select
          value={sel.fontName || ""}
          title="Font"
          options={FONTS}
          emptyLabel="Font"
          className="w-32"
          onChange={(v) => exec("fontName", v)}
        />
        <Select
          value={sel.fontSize || ""}
          title="Font size"
          options={SIZES.map((s) => [String(s), `${s}`])}
          emptyLabel="Size"
          className="w-16"
          onChange={(v) => applyFontSize(Number(v))}
        />
        <Divider />

        <Btn title="Bold (Ctrl+B)" active={sel.bold} disabled={mode === "viewing"} onClick={() => exec("bold")}>
          <span className="text-sm font-bold">B</span>
        </Btn>
        <Btn title="Italic (Ctrl+I)" active={sel.italic} disabled={mode === "viewing"} onClick={() => exec("italic")}>
          <span className="text-sm italic">I</span>
        </Btn>
        <Btn title="Underline (Ctrl+U)" active={sel.underline} disabled={mode === "viewing"} onClick={() => exec("underline")}>
          <span className="text-sm underline">U</span>
        </Btn>
        <input
          type="color"
          defaultValue="#000000"
          title="Text color"
          disabled={mode === "viewing"}
          onChange={(e) => exec("foreColor", e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          className="h-8 w-7 cursor-pointer rounded-md border border-zinc-300 bg-white p-0.5"
        />
        <input
          type="color"
          defaultValue="#ffff00"
          title="Highlight color"
          disabled={mode === "viewing"}
          onChange={(e) => exec("hiliteColor", e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          className="h-8 w-7 cursor-pointer rounded-md border border-zinc-300 bg-white p-0.5"
        />
        <Divider />

        <Btn title="Insert link" disabled={mode === "viewing"} onClick={() => {
          const url = window.prompt("Link URL:", "https://");
          if (url) exec("createLink", url);
        }}>
          {ICONS.link}
        </Btn>
        <Btn title="Add comment" disabled={mode === "viewing"} onClick={onAddComment}>
          {ICONS.comment}
        </Btn>
        <Btn title="Insert image" disabled={mode === "viewing"} onClick={() => {
          const url = window.prompt("Image URL:", "https://");
          if (url) exec("insertImage", url);
        }}>
          {ICONS.image}
        </Btn>
        <Divider />

        <IconDropdown
          title="Align & indent"
          currentIcon={ICONS[activeAlign] || ICONS.alignLeft}
          value={activeAlign}
          onSelect={(v) => {
            const map = {
              alignLeft: "justifyLeft",
              alignCenter: "justifyCenter",
              alignRight: "justifyRight",
              alignFull: "justifyFull",
            };
            exec(map[v]);
          }}
          items={[
            ["alignLeft", "Align left", ICONS.alignLeft],
            ["alignCenter", "Align center", ICONS.alignCenter],
            ["alignRight", "Align right", ICONS.alignRight],
            ["alignFull", "Justify", ICONS.alignJustify],
          ]}
        />
        <IconDropdown
          title="Line & paragraph spacing"
          currentIcon={ICONS.spacing}
          value=""
          onSelect={(v) => applyLineSpacing(Number(v))}
          items={SPACINGS.map((s) => [s, `${s}x`, ICONS.spacing])}
        />
        <Divider />

        <Btn title="Checklist" disabled={mode === "viewing"} onClick={insertChecklist}>
          {ICONS.checklist}
        </Btn>
        <Btn title="Bulleted list" active={sel.ul} disabled={mode === "viewing"} onClick={() => exec("insertUnorderedList")}>
          {ICONS.bullet}
        </Btn>
        <Btn title="Numbered list" active={sel.ol} disabled={mode === "viewing"} onClick={() => exec("insertOrderedList")}>
          {ICONS.number}
        </Btn>
        <Divider />

        <div className="relative">
          <Btn title="More" active={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
            {ICONS.more}
          </Btn>
          {moreOpen ? (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMoreOpen(false)} />
              <div className="absolute left-0 top-full z-20 mt-1 w-44 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg">
                <MenuRow onClick={() => { exec("outdent"); setMoreOpen(false); }}>
                  Decrease indent
                </MenuRow>
                <MenuRow onClick={() => { exec("indent"); setMoreOpen(false); }}>
                  Increase indent
                </MenuRow>
                <MenuRow onClick={() => { exec("removeFormat"); setMoreOpen(false); }}>
                  Clear formatting
                </MenuRow>
                <div className="mx-3 my-1 border-t border-zinc-100" />
                <MenuRow onClick={() => { if (onPageBreak) onPageBreak(); else exec("insertHTML", "<div data-pagebreak='1'></div>"); setMoreOpen(false); }}>
                  <span className="text-zinc-600">{ICONS.pageBreak}</span>
                  <span>Page break</span>
                  <span className="ml-auto text-[10px] text-zinc-400">Ctrl+Enter</span>
                </MenuRow>
              </div>
            </>
          ) : null}
        </div>

        <div className="flex-1" />

        <IconDropdown
          title={`Mode: ${
            mode === "editing"
              ? "Editing"
              : mode === "suggesting"
                ? "Suggesting"
                : "Viewing"
          }`}
          currentIcon={MODE_ICONS[mode] || MODE_ICONS.editing}
          value={mode}
          onSelect={(v) => setMode(v)}
          items={MODES.map(([val, label]) => [val, label, MODE_ICONS[val]])}
          align="right"
        />
      </div>

      {findOpen ? (
        <div className="flex items-center gap-2 border-t border-zinc-100 bg-zinc-50 px-3 py-1.5">
          <input
            ref={findRef}
            autoFocus
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doFind();
              if (e.key === "Escape") closeFind();
            }}
            placeholder="Find in document"
            className="h-8 w-56 rounded-md border border-zinc-300 bg-white px-2 text-xs outline-none focus:border-blue-400"
          />
          <button
            type="button"
            onClick={doFind}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            Find
          </button>
          <button
            type="button"
            onClick={closeFind}
            className="rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100"
          >
            Close
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MenuRow({ onClick, children }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
      className="flex w-full items-center px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-100"
    >
      {children}
    </button>
  );
}