/**
 * PROTOTYPE — issue #234. Throwaway, never merged. Lives on `prototype/234-banner-shrink-wrap`.
 *
 * Question: how far may the call banner shrink, how many lines may it wrap to, and so what is
 * the longest custom call that fits at worst-case widths on a 360px phone?
 *
 * Opened with `?proto=banner` on the live table (any phase): every chosen seat gets a frozen
 * banner carrying the prototype's text, and a floating bar edits it. Everything lives in the
 * URL so a configuration is shareable and survives a reload.
 */

import { useSyncExternalStore } from "react";

export type ProtoSeat = "left" | "top" | "right" | "me";

export interface ProtoConfig {
  on: boolean;
  text: string;
  kind: "yaniv" | "assaf";
  seats: readonly ProtoSeat[];
  /** The shrink-step table being tried — see `STEP_TABLES`. */
  steps: string;
  /** How many lines the banner may wrap to. */
  lines: number;
  /** The banner's widest line, in vw. */
  width: number;
}

/**
 * Candidate shrink-step tables: `[upToLength, fontVw]`, read top-down, the first row whose
 * length bound is not exceeded wins. Today's banner is `clamp(2.1rem, 18vw, 4.4rem)`; each
 * step keeps that shape and scales all three terms together, so a step is the same banner
 * drawn smaller at every width, as ADR-0018 wants.
 */
export const STEP_TABLES: Record<string, ReadonlyArray<readonly [number, number]>> = {
  // Derived: one line for average-width text as long as possible, and a run of W inside
  // three lines at every step. Floor is half the shout.
  D: [
    [5, 1],
    [6, 0.8],
    [8, 0.65],
    [Infinity, 0.5],
  ],
  // The same derivation for a two-line limit: the floor has to drop to 0.4 to hold 20.
  E: [
    [5, 1],
    [6, 0.8],
    [8, 0.65],
    [10, 0.5],
    [Infinity, 0.4],
  ],
  // Three steps, then wrap.
  A: [
    [6, 1],
    [9, 0.72],
    [Infinity, 0.5],
  ],
  // Four steps, a gentler floor.
  B: [
    [6, 1],
    [8, 0.8],
    [11, 0.62],
    [Infinity, 0.5],
  ],
  // Floor lower still.
  C: [
    [6, 1],
    [8, 0.8],
    [11, 0.62],
    [15, 0.5],
    [Infinity, 0.42],
  ],
};

export function stepFor(steps: string, length: number): number {
  const table = STEP_TABLES[steps] ?? STEP_TABLES.A ?? [];
  for (const [upTo, scale] of table) if (length <= upTo) return scale;
  return table.at(-1)?.[1] ?? 1;
}

function read(): ProtoConfig {
  const p = new URLSearchParams(window.location.search);
  return {
    on: p.get("proto") === "banner",
    text: p.get("text") ?? "YANIV",
    kind: p.get("kind") === "assaf" ? "assaf" : "yaniv",
    seats: (p.get("seats") ?? "left,top,me").split(",").filter(Boolean) as ProtoSeat[],
    steps: p.get("steps") ?? "D",
    lines: Number(p.get("lines") ?? 3),
    width: Number(p.get("width") ?? 90),
  };
}

let current = read();
const listeners = new Set<() => void>();

export function setProto(patch: Partial<ProtoConfig>) {
  current = { ...current, ...patch };
  const p = new URLSearchParams(window.location.search);
  p.set("proto", "banner");
  p.set("text", current.text);
  p.set("kind", current.kind);
  p.set("seats", current.seats.join(","));
  p.set("steps", current.steps);
  p.set("lines", String(current.lines));
  p.set("width", String(current.width));
  window.history.replaceState(null, "", `?${p.toString()}`);
  for (const l of listeners) l();
}

export function useProto(): ProtoConfig {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

// For driving the prototype from devtools.
(window as unknown as { __setProto: typeof setProto }).__setProto = setProto;
