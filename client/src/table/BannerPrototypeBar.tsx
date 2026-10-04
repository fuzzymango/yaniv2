/**
 * PROTOTYPE — issue #234. Throwaway, never merged.
 *
 * The floating bar that drives `?proto=banner`: the text, the worst-case presets, which seats
 * get a banner, the step table, the line limit and the width — and, under it, a measurement
 * of every banner on screen: lines used, width, and whether it left the screen. A banner that
 * breaks a limit is outlined in magenta.
 */

import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import type { ProtoSeat } from "../bannerPrototype.ts";
import { STEP_TABLES, setProto, stepFor, useProto } from "../bannerPrototype.ts";

/** Worst cases: one glyph, repeated. Wide letters the display-name rule allows. */
const GLYPHS: Record<string, string> = {
  W: "W",
  M: "M",
  "Ш (Cyrillic)": "Ш",
  "龘 (Han)": "龘",
  "뷁 (Hangul)": "뷁",
  "ꙮ (Cyrillic)": "ꙮ",
  "ß → SS": "ß",
  "ﬃ → FFI": "ﬃ",
  "ﷺ (Arabic lig.)": "ﷺ",
};

const SEATS: ProtoSeat[] = ["left", "top", "right", "me"];

interface Measured {
  zone: string;
  lines: number;
  width: number;
  fontPx: number;
  offscreen: boolean;
  tooTall: boolean;
}

function measure(): Measured[] {
  const out: Measured[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(".announce--proto")) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const fontPx = parseFloat(style.fontSize);
    const lineH = parseFloat(style.lineHeight) || fontPx;
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const lines = Math.round((el.offsetHeight - padY) / lineH);
    const offscreen =
      rect.left < -0.5 ||
      rect.right > window.innerWidth + 0.5 ||
      rect.top < -0.5 ||
      rect.bottom > window.innerHeight + 0.5;
    const tooTall = lines > Number(el.dataset.protoLines);
    el.style.outline = offscreen || tooTall ? "3px dashed magenta" : "";
    const seat = el.closest(".table-seat");
    const zone =
      seat === null
        ? "me"
        : (["left", "top", "right"].find((z) => seat.classList.contains(`table-seat--${z}`)) ??
          "?");
    out.push({ zone, lines, width: Math.round(rect.width), fontPx, offscreen, tooTall });
  }
  return out;
}

export function BannerPrototypeBar() {
  const proto = useProto();
  const [open, setOpen] = useState(true);
  const [glyph, setGlyph] = useState("W");
  const [count, setCount] = useState(20);
  const [measured, setMeasured] = useState<Measured[]>([]);

  useEffect(() => {
    // After layout and fonts: measure twice, the second catching a late font swap.
    const a = requestAnimationFrame(() => setMeasured(measure()));
    const b = window.setTimeout(() => setMeasured(measure()), 300);
    return () => {
      cancelAnimationFrame(a);
      window.clearTimeout(b);
    };
  });

  const said = proto.text.trim().toLocaleUpperCase();
  const bar: CSSProperties = {
    position: "fixed",
    left: 4,
    right: 4,
    top: "38%",
    zIndex: 1000,
    background: "rgba(10,10,30,0.92)",
    color: "#eee",
    border: "1px solid #888",
    borderRadius: 8,
    padding: 6,
    font: "11px/1.4 ui-monospace, monospace",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  };

  if (!open) {
    return (
      <button
        type="button"
        style={{ ...bar, right: "auto", top: "auto", bottom: 4, padding: "2px 6px", opacity: 0.4 }}
        onClick={() => setOpen(true)}
      >
        proto
      </button>
    );
  }

  return (
    <div style={bar} data-proto-bar>
      <div style={{ display: "flex", gap: 4 }}>
        <input
          style={{ flex: 1, font: "inherit" }}
          value={proto.text}
          onChange={(e) => setProto({ text: e.target.value })}
        />
        <button type="button" onClick={() => setOpen(false)}>
          hide
        </button>
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
        <select value={glyph} onChange={(e) => setGlyph(e.target.value)}>
          {Object.keys(GLYPHS).map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        ×
        <input
          type="number"
          style={{ width: 40 }}
          value={count}
          onChange={(e) => setCount(Number(e.target.value))}
        />
        <button type="button" onClick={() => setProto({ text: (GLYPHS[glyph] ?? "W").repeat(count) })}>
          run
        </button>
        <button
          type="button"
          onClick={() => {
            // Adversarial for word wrap: a one-letter word, then words one short of a line.
            const words: string[] = [];
            let len = 0;
            const g = GLYPHS[glyph] ?? "W";
            for (let i = 0; len < count; i += 1) {
              const w: string = i % 2 === 0 ? g : g.repeat(5);
              words.push(w);
              len += w.length + 1;
            }
            setProto({ text: words.join(" ").slice(0, count).trim() });
          }}
        >
          spaced
        </button>
        <button type="button" onClick={() => setProto({ text: "YANIV" })}>
          YANIV
        </button>
        <button
          type="button"
          onClick={() => setProto({ kind: proto.kind === "yaniv" ? "assaf" : "yaniv" })}
        >
          {proto.kind}
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {SEATS.map((s) => (
          <label key={s}>
            <input
              type="checkbox"
              checked={proto.seats.includes(s)}
              onChange={(e) =>
                setProto({
                  seats: e.target.checked
                    ? [...proto.seats, s]
                    : proto.seats.filter((x) => x !== s),
                })
              }
            />
            {s}
          </label>
        ))}
        steps
        <select value={proto.steps} onChange={(e) => setProto({ steps: e.target.value })}>
          {Object.keys(STEP_TABLES).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        lines
        <input
          type="number"
          style={{ width: 32 }}
          value={proto.lines}
          onChange={(e) => setProto({ lines: Number(e.target.value) })}
        />
        w(vw)
        <input
          type="number"
          style={{ width: 40 }}
          value={proto.width}
          onChange={(e) => setProto({ width: Number(e.target.value) })}
        />
      </div>
      <div>
        len {said.length} (typed {proto.text.trim().length}) · scale{" "}
        {stepFor(proto.steps, said.length)} · steps {proto.steps}:{" "}
        {STEP_TABLES[proto.steps]
          ?.map(([n, s]) => `≤${n === Infinity ? "∞" : n}→${s}`)
          .join(" ")}
      </div>
      {measured.map((m, i) => (
        <div key={i} style={{ color: m.offscreen || m.tooTall ? "#f6f" : "#9f9" }}>
          {m.zone}: {m.lines} line(s), {m.width}px wide, {m.fontPx.toFixed(1)}px font
          {m.offscreen ? " · OFFSCREEN" : ""}
          {m.tooTall ? " · TOO MANY LINES" : ""}
        </div>
      ))}
    </div>
  );
}
