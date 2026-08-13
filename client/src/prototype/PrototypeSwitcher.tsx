/**
 * [PROTOTYPE — issue #56] Floating bottom bar for flipping between seating-layout
 * variants. Throwaway: not part of the feature, gone once a variant is picked.
 */

import { useEffect, type CSSProperties } from "react";

export const VARIANTS = [
  { key: "control", label: "Control — today's text list" },
  { key: "a", label: "A — Felt oval" },
  { key: "b", label: "B — Minimal corners" },
  { key: "c", label: "C — Compact stacked" },
] as const;

export type VariantKey = (typeof VARIANTS)[number]["key"];

export function readVariant(): VariantKey {
  const raw = new URLSearchParams(window.location.search).get("variant");
  return VARIANTS.some((v) => v.key === raw) ? (raw as VariantKey) : "control";
}

function setVariant(key: VariantKey) {
  const url = new URL(window.location.href);
  url.searchParams.set("variant", key);
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new Event("prototype-variant-change"));
}

export function PrototypeSwitcher() {
  if (!import.meta.env.DEV) return null;

  const current = readVariant();
  const index = Math.max(
    VARIANTS.findIndex((v) => v.key === current),
    0,
  );

  const cycle = (delta: number) => {
    const next = VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length] ?? VARIANTS[0];
    setVariant(next.key);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      if (e.key === "ArrowLeft") cycle(-1);
      if (e.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        bottom: "0.75rem",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.4rem 0.6rem",
        borderRadius: "999px",
        background: "#111",
        color: "#fff",
        boxShadow: "0 4px 16px rgb(0 0 0 / 45%)",
        fontSize: "0.8rem",
        zIndex: 9999,
      }}
    >
      <button type="button" onClick={() => cycle(-1)} style={switcherButtonStyle}>
        ←
      </button>
      <span style={{ minWidth: "11rem", textAlign: "center" }}>{(VARIANTS[index] ?? VARIANTS[0]).label}</span>
      <button type="button" onClick={() => cycle(1)} style={switcherButtonStyle}>
        →
      </button>
    </div>
  );
}

const switcherButtonStyle: CSSProperties = {
  border: "1px solid #444",
  borderRadius: "999px",
  background: "#222",
  color: "#fff",
  width: "1.75rem",
  height: "1.75rem",
  cursor: "pointer",
};
