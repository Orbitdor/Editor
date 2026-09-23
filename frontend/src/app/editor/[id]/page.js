"use client";

import { useEffect, useState, useRef, useCallback, useLayoutEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { getDoc, saveDoc, createDoc } from "@/lib/api";
import { TopRuler, LeftRuler } from "@/components/Rulers";
import MenuBar from "@/components/MenuBar";
import Toolbar from "@/components/Toolbar";

const PAGE_W = 808;
const PAGE_H = 1120;
const PAD_R = 72;
const PAD_B = 72;
const GAP = 16;
const BREAK = '<div data-pagebreak="1"></div>';

let keySeq = 0;
const genKey = () => `p${++keySeq}`;

function isBreakNode(node) {
  return node.nodeType === 1 && node.getAttribute("data-pagebreak") === "1";
}

function textLen(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  let len = 0;
  while ((n = w.nextNode())) len += n.nodeValue.length;
  return len;
}

function offsetIn(el, node, off) {
  if (node === el) {
    let sum = 0;
    const max = Math.min(off, el.childNodes.length);
    for (let i = 0; i < max; i++) sum += textLen(el.childNodes[i]);
    return sum;
  }
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  let pos = 0;
  while ((n = w.nextNode())) {
    if (n === node) return pos + off;
    pos += n.nodeValue.length;
  }
  return pos;
}

function placeCaret(el, off) {
  if (!el) return;
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  let pos = 0;
  while ((n = w.nextNode())) {
    if (pos + n.nodeValue.length >= off) {
      const r = document.createRange();
      r.setStart(n, Math.min(off - pos, n.nodeValue.length));
      r.collapse(true);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return;
    }
    pos += n.nodeValue.length;
  }
  const target = el.lastElementChild || el;
  const r = document.createRange();
  r.selectNodeContents(target);
  r.collapse(false);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

function paginate(html, indentLeft, indentTop, forcedBefore = new Set()) {
  const contentW = PAGE_W - indentLeft - PAD_R - 2;
  const limit = PAGE_H - indentTop - PAD_B - 2;
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;";
  document.body.appendChild(wrap);
  const mk = () => {
    const p = document.createElement("div");
    p.className = "editable-area";
    p.style.cssText = `box-sizing:border-box;width:${contentW}px;padding:0;margin:0;min-height:0;height:auto;font-size:16px;line-height:32px;font-family:Arial,Helvetica,sans-serif;white-space:normal;`;
    wrap.appendChild(p);
    return p;
  };
  const page = mk();
  page.innerHTML = html || "";
  const nodes = Array.from(page.childNodes);
  let cur = page;
  nodes.forEach((node, idx) => {
    if (forcedBefore.has(idx)) cur = mk();
    cur.appendChild(node);
    if (cur.childNodes.length > 1) {
      const pr = cur.getBoundingClientRect();
      const nr =
        node.nodeType === 1
          ? node.getBoundingClientRect()
          : node.parentElement?.getBoundingClientRect() ||
            cur.lastElementChild?.getBoundingClientRect() ||
            cur.getBoundingClientRect();
      const mb =
        node.nodeType === 1
          ? parseFloat(getComputedStyle(node).marginBottom) || 0
          : 0;
      if (nr.bottom - pr.top + mb > limit) {
        cur.removeChild(node);
        cur = mk();
        cur.appendChild(node);
      }
    }
  });
  if (forcedBefore.has(nodes.length)) cur = mk();
  const out = Array.from(wrap.children).map((p) => p.innerHTML);
  document.body.removeChild(wrap);
  return out.length ? out : [""];
}

function withBreaks(html, set) {
  const t = document.createElement("div");
  t.innerHTML = html || "";
  const out = [];
  Array.from(t.childNodes).forEach((n, i) => {
    if (set.has(i)) out.push(BREAK);
    if (n.nodeType === 1) out.push(n.outerHTML);
    else if (n.nodeType === 3) out.push(n.nodeValue);
  });
  return out.join("");
}

function parseBreaks(html) {
  const t = document.createElement("div");
  t.innerHTML = html || "";
  const out = [];
  const set = new Set();
  let pending = 0;
  Array.from(t.childNodes).forEach((n) => {
    if (isBreakNode(n)) {
      pending += 1;
      return;
    }
    if (pending) {
      set.add(out.length);
      pending = 0;
    }
    if (n.nodeType === 1) out.push(n.outerHTML);
    else if (n.nodeType === 3) out.push(n.nodeValue);
  });
  return { html: out.join(""), breaks: set };
}

export default function Editor() {
  const { id } = useParams();
  const router = useRouter();
  const [title, setTitle] = useState("Untitled");
  const [loaded, setLoaded] = useState(false);
  const [rev, setRev] = useState(0);
  const [indentLeft, setIndentLeft] = useState(56);
  const [indentTop, setIndentTop] = useState(48);
  const [mode, setMode] = useState("editing");
  const [zoom, setZoom] = useState(100);
  const [comments, setComments] = useState([]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [pages, setPages] = useState([]);

  const titleRef = useRef(null);
  const editorRef = useRef(null);
  const htmlRef = useRef("");
  const dirtyRef = useRef(false);
  const loadedRef = useRef(false);
  const pagesRef = useRef([]);
  const elsRef = useRef({});
  const indentLRef = useRef(56);
  const indentTRef = useRef(48);
  const rafRef = useRef(0);
  const caretRef = useRef(null);
  const forceCaretRef = useRef(null);
  const breaksPosRef = useRef(new Set());

  const readCombined = useCallback(() => {
    return pagesRef.current
      .map((p) => elsRef.current[p.key]?.innerHTML ?? p.html)
      .join("");
  }, []);

  function captureCaret() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    let total = 0;
    for (const p of pagesRef.current) {
      const el = elsRef.current[p.key];
      if (!el) continue;
      if (el === r.startContainer || el.contains(r.startContainer)) {
        return total + offsetIn(el, r.startContainer, r.startOffset);
      }
      total += textLen(el);
    }
    return null;
  }

  function caretPageIdx() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    const node = sel.getRangeAt(0).startContainer;
    return pagesRef.current.findIndex((p) => {
      const el = elsRef.current[p.key];
      return el && (el === node || el.contains(node));
    });
  }

  function caretNodeIndex() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return -1;
    const node = sel.getRangeAt(0).startContainer;
    let total = 0;
    for (const p of pagesRef.current) {
      const el = elsRef.current[p.key];
      if (!el) continue;
      const cnt = el.childNodes.length;
      if (el === node || el.contains(node)) {
        if (el === node) return total + cnt;
        let c = node.nodeType === 3 ? node.parentNode : node;
        while (c && c.parentNode && c.parentNode !== el) c = c.parentNode;
        let k = -1;
        if (c && c.parentNode === el) {
          k = Array.prototype.indexOf.call(el.childNodes, c);
        } else if (node.nodeType === 3 && node.parentNode === el) {
          k = Array.prototype.indexOf.call(el.childNodes, node);
        }
        if (k < 0) k = cnt - 1;
        if (k < 0) return total;
        return total + k + 1;
      }
      total += cnt;
    }
    return -1;
  }

  function repaginateNow() {
    if (!loadedRef.current) return;
    const combined = readCombined();
    const out = paginate(
      combined,
      indentLRef.current,
      indentTRef.current,
      breaksPosRef.current
    );
    const cur = pagesRef.current;
    const els = cur.map((p) => elsRef.current[p.key]);
    const same =
      out.length === cur.length &&
      out.every((h, i) => els[i] && els[i].innerHTML === h);
    if (same) return;
    const caret =
      forceCaretRef.current != null
        ? { page: forceCaretRef.current }
        : captureCaret();
    forceCaretRef.current = null;
    const keys = cur.map((p) => p.key);
    while (keys.length < out.length) keys.push(genKey());
    const next = out.map((html, i) => ({ key: keys[i], html }));
    htmlRef.current = out.join("");
    dirtyRef.current = true;
    caretRef.current = caret;
    pagesRef.current = next;
    setRev((r) => r + 1);
    setPages(next);
  }

  function scheduleRepaginate() {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => repaginateNow());
  }

  const syncFromEditor = useCallback(() => {
    htmlRef.current = readCombined();
    dirtyRef.current = true;
    setRev((r) => r + 1);
    scheduleRepaginate();
  }, [readCombined]);

  useLayoutEffect(() => {
    const t = caretRef.current;
    if (t == null) return;
    caretRef.current = null;
    const els = pages
      .map((p) => elsRef.current[p.key])
      .filter(Boolean);
    if (!els.length) return;
    if (typeof t === "object" && t.page != null) {
      placeCaret(els[Math.min(t.page, els.length - 1)], 0);
      return;
    }
    let off = t;
    for (let i = 0; i < els.length; i++) {
      const len = textLen(els[i]);
      if (off <= len) {
        placeCaret(els[i], off);
        return;
      }
      off -= len;
    }
    const last = els[els.length - 1];
    placeCaret(last, textLen(last));
  }, [pages]);

  async function handleNew() {
    const doc = await createDoc();
    router.push(`/editor/${doc._id}`);
  }

  function saveNow() {
    dirtyRef.current = false;
    saveDoc(id, {
      title,
      content: withBreaks(readCombined(), breaksPosRef.current),
    }).catch((err) => console.error(err));
  }

  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);

  useEffect(() => {
    getDoc(id)
      .then((doc) => {
        setTitle(doc.title ?? "Untitled");
        const { html, breaks } = parseBreaks(doc.content ?? "");
        breaksPosRef.current = breaks;
        const out = paginate(
          html,
          indentLRef.current,
          indentTRef.current,
          breaks
        );
        htmlRef.current = out.join("");
        const next = out.map((html) => ({ key: genKey(), html }));
        pagesRef.current = next;
        setPages(next);
        setLoaded(true);
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => scheduleRepaginate());
        }
      })
      .catch((err) => {
        console.error(err);
        const next = [{ key: genKey(), html: "" }];
        pagesRef.current = next;
        setPages(next);
        setLoaded(true);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!loaded || !dirtyRef.current) return;
    const t = setTimeout(() => {
      dirtyRef.current = false;
      saveDoc(id, {
        title,
        content: withBreaks(readCombined(), breaksPosRef.current),
      }).catch((err) => console.error(err));
    }, 1000);
    return () => clearTimeout(t);
  }, [rev, title, id, loaded]);

  function addComment() {
    const sel = window.getSelection()?.toString().trim();
    const text = window.prompt(
      sel ? "Comment on selection:" : "Comment:",
      ""
    );
    if (text === null) return;
    setComments((c) => [
      ...c,
      {
        id: Date.now(),
        sel: sel || "(no selection)",
        text,
        time: new Date().toLocaleString(),
      },
    ]);
    setCommentsOpen(true);
  }

  function handleKeyDown(e, idx) {
    if (
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === "s"
    ) {
      e.preventDefault();
      saveNow();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      insertPageBreak();
      return;
    }
    if (e.key === "Backspace" && idx > 0 && !viewOnly) {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed && sel.rangeCount && sel.anchorNode) {
        const el = e.currentTarget;
        if (el === sel.anchorNode || el.contains(sel.anchorNode)) {
          if (offsetIn(el, sel.anchorNode, sel.anchorOffset) === 0) {
            e.preventDefault();
            let before = 0;
            for (let i = 0; i < idx; i++) {
              before +=
                elsRef.current[pagesRef.current[i]?.key]?.childNodes
                  .length ?? 0;
            }
            breaksPosRef.current.delete(before);
            const prev = elsRef.current[pagesRef.current[idx - 1]?.key];
            const first = el.firstChild;
            if (first && prev) prev.appendChild(first);
            htmlRef.current = readCombined();
            dirtyRef.current = true;
            setRev((r) => r + 1);
            scheduleRepaginate();
          }
        }
      }
    }
  }

  function insertPageBreak() {
    if (viewOnly) return;
    const nodeIdx = caretNodeIndex();
    if (nodeIdx < 0) return;
    const cIdx = caretPageIdx();
    breaksPosRef.current.add(nodeIdx);
    forceCaretRef.current = cIdx >= 0 ? cIdx + 1 : null;
    htmlRef.current = readCombined();
    dirtyRef.current = true;
    setRev((r) => r + 1);
    scheduleRepaginate();
  }

  function setIndentLeftAll(v) {
    indentLRef.current = v;
    setIndentLeft(v);
    scheduleRepaginate();
  }

  function setIndentTopAll(v) {
    indentTRef.current = v;
    setIndentTop(v);
    scheduleRepaginate();
  }

  const viewOnly = mode === "viewing";

  const firstEmpty =
    loaded &&
    pages.length === 1 &&
    !pages[0].html.replace(/<[^>]+>/g, "").trim();

  return (
    <div className="flex flex-1 flex-col">
      <div className="border-b border-zinc-200 bg-white">
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
          <input
            ref={titleRef}
            value={title}
            readOnly={viewOnly}
            onChange={(e) => {
              setTitle(e.target.value);
              dirtyRef.current = true;
            }}
            className="min-w-0 flex-1 rounded-md border border-transparent px-2 py-1 text-sm font-medium outline-none focus:border-blue-400"
            placeholder="Untitled"
          />
        </div>
        <MenuBar
          onNew={handleNew}
          onSave={saveNow}
          onRename={() => titleRef.current?.focus()}
        />
        <Toolbar
          editorRef={editorRef}
          mode={mode}
          setMode={setMode}
          zoom={zoom}
          setZoom={setZoom}
          onEdit={syncFromEditor}
          onAddComment={addComment}
          onPageBreak={insertPageBreak}
          commentsOpen={commentsOpen}
          setCommentsOpen={setCommentsOpen}
        />
      </div>

      <div className="editor-canvas relative flex-1 overflow-auto bg-[#e8eaed] px-4 py-10">
        <div
          className="print-hide absolute left-0 w-[18px]"
          style={{ top: 70, height: PAGE_H }}
        >
          <LeftRuler
            height={PAGE_H}
            indentTop={indentTop}
            onIndentTop={setIndentTopAll}
          />
        </div>
        <div
          className="editor-zoom-wrap"
          style={{
            transform: `scale(${zoom / 100})`,
            transformOrigin: "top center",
          }}
        >
          <div className="mx-auto w-fit">
            <div className="print-hide flex">
              <div className="w-6 shrink-0" />
              <TopRuler
                width={PAGE_W}
                indentLeft={indentLeft}
                onIndentLeft={setIndentLeftAll}
              />
            </div>
            <div className="ml-6">
              <div className="print-area relative" style={{ width: PAGE_W }}>
                {pages.map((p, idx) => (
                  <div
                    key={p.key}
                    ref={(el) => {
                      if (el) {
                        elsRef.current[p.key] = el;
                        if (!editorRef.current) editorRef.current = el;
                      } else {
                        delete elsRef.current[p.key];
                      }
                    }}
                    contentEditable={!viewOnly}
                    suppressContentEditableWarning
                    spellCheck
                    className="print-page editable-area text-base leading-8 text-zinc-900 outline-none"
                    style={{
                      width: PAGE_W,
                      height: PAGE_H,
                      padding: `${indentTop}px ${PAD_R}px ${PAD_B}px ${indentLeft}px`,
                      background: "#fff",
                      border: "1px solid #e4e4e7",
                      boxShadow: "0 1px 4px rgba(0,0,0,0.12)",
                      marginBottom: GAP,
                      overflow: "hidden",
                    }}
                    dangerouslySetInnerHTML={{ __html: p.html }}
                    onFocus={(e) => {
                      editorRef.current = e.currentTarget;
                    }}
                    onInput={(e) => {
                      if (e.nativeEvent && e.nativeEvent.isComposing) return;
                      htmlRef.current = readCombined();
                      dirtyRef.current = true;
                      setRev((r) => r + 1);
                      scheduleRepaginate();
                    }}
                    onKeyDown={(e) => handleKeyDown(e, idx)}
                  />
                ))}
                {firstEmpty ? (
                  <div
                    aria-hidden
                    className="print-hide pointer-events-none absolute text-base leading-8 text-zinc-400"
                    style={{ top: indentTop, left: indentLeft }}
                  >
                    Start writing...
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {commentsOpen && comments.length > 0 ? (
          <div className="absolute right-4 top-4 w-72 rounded-lg border border-zinc-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2">
              <span className="text-sm font-semibold text-zinc-700">
                Comments ({comments.length})
              </span>
              <button
                type="button"
                onClick={() => setCommentsOpen(false)}
                className="rounded px-1 text-zinc-500 hover:bg-zinc-100"
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto p-2">
              {comments.map((c) => (
                <div
                  key={c.id}
                  className="mb-2 rounded-md border border-zinc-100 bg-zinc-50 p-2"
                >
                  <div className="mb-1 rounded bg-yellow-50 px-1.5 py-0.5 text-xs italic text-zinc-500">
                    {c.sel.slice(0, 80)}
                  </div>
                  <p className="text-xs text-zinc-700">{c.text}</p>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-[10px] text-zinc-400">{c.time}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setComments((all) => all.filter((x) => x.id !== c.id))
                      }
                      className="text-[10px] text-zinc-400 hover:text-red-500"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
