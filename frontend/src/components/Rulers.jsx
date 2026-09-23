"use client";

import { useRef } from "react";

const STEP = 48;

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

function useDrag() {
  const ref = useRef({ axis: "x", startPos: 0, startVal: 0, id: -1 });

  function down(e, val) {
    ref.current = {
      axis: e.currentTarget.dataset.axis || "x",
      startPos: e.currentTarget.dataset.axis === "y" ? e.clientY : e.clientX,
      startVal: num(val),
      id: e.pointerId,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function move(e, onChange, max) {
    const d = ref.current;
    if (d.id !== e.pointerId) return;
    const pos = d.axis === "y" ? e.clientY : e.clientX;
    const delta = pos - d.startPos;
    const next = Math.max(0, Math.min(num(max), d.startVal + delta));
    onChange(next);
  }

  function up(e) {
    if (ref.current.id === e.pointerId) ref.current.id = -1;
  }

  return { down, move, up };
}

export function TopRuler({ width, indentLeft, onIndentLeft }) {
  const { down, move, up } = useDrag();
  const w = num(width);
  const markerLeft = num(indentLeft);
  const ticks = [];
  const numerals = [];
  const count = Math.max(0, Math.floor(w / STEP));

  for (let i = 0; i <= count; i++) {
    const major = i % 2 === 0;
    ticks.push(
      <span
        key={i}
        className={`absolute bottom-0 w-px ${
          major ? "h-2.5 bg-zinc-500/60" : "h-1 bg-zinc-400/50"
        }`}
        style={{ left: i * STEP }}
      />
    );
    if (major) {
      numerals.push(
        <span
          key={`n${i}`}
          className="absolute bottom-0.5 text-[8px] leading-none text-zinc-500"
          style={{ left: i * STEP + 3 }}
        >
          {i / 2}
        </span>
      );
    }
  }

  return (
    <div className="relative mb-2.5 h-5 w-full rounded-[20px] border-b border-zinc-300 bg-white">
      {ticks}
      {numerals}
      <div
        data-axis="x"
        className="absolute bottom-0 z-10 h-full w-[11px] cursor-ew-resize touch-none select-none"
        style={{ left: Math.max(0, markerLeft - 5) }}
        onPointerDown={(e) => down(e, markerLeft)}
        onPointerMove={(e) => move(e, onIndentLeft, w)}
        onPointerUp={up}
      >
        <div className="absolute bottom-[3px] left-[1px] right-[1px] h-[7px] rounded-[2px] bg-zinc-500/60 hover:bg-zinc-500" />
        <div className="absolute bottom-0 left-0 right-0 border-l-[5px] border-r-[5px] border-t-[5px] border-l-transparent border-r-transparent border-t-zinc-500" />
      </div>
    </div>
  );
}

export function LeftRuler({ height, indentTop, onIndentTop }) {
  const { down, move, up } = useDrag();
  const h = num(height);
  const markerTop = num(indentTop);
  const ticks = [];
  const numerals = [];
  const count = Math.max(0, Math.floor(h / STEP));

  for (let i = 0; i <= count; i++) {
    const major = i % 2 === 0;
    ticks.push(
      <span
        key={i}
        className={`absolute right-0 h-px ${
          major ? "w-2.5 bg-zinc-500/60" : "w-1 bg-zinc-400/50"
        }`}
        style={{ top: i * STEP }}
      />
    );
    if (major) {
      numerals.push(
        <span
          key={`n${i}`}
          className="absolute right-1 text-[8px] leading-none text-zinc-500"
          style={{ top: i * STEP + 3 }}
        >
          {i / 2}
        </span>
      );
    }
  }

  return (
    <div className="relative h-full w-[18px] shrink-0 border-r border-zinc-300 bg-white">
      {ticks}
      {numerals}
      <div
        data-axis="y"
        className="absolute left-0 z-10 h-[11px] w-full cursor-ns-resize touch-none select-none"
        style={{ top: Math.max(0, markerTop - 5) }}
        onPointerDown={(e) => down(e, markerTop)}
        onPointerMove={(e) => move(e, onIndentTop, h)}
        onPointerUp={up}
      >
        <div className="absolute left-[3px] top-[1px] bottom-[1px] w-[7px] rounded-[2px] bg-zinc-500/60 hover:bg-zinc-500" />
        <div className="absolute left-0 top-0 bottom-0 border-t-[5px] border-b-[5px] border-r-[5px] border-t-transparent border-b-transparent border-r-zinc-500" />
      </div>
    </div>
  );
}