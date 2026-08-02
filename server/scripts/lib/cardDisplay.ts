/**
 * Low-level card rendering primitives shared by every terminal harness (`cli/render.ts`,
 * `play.ts`). Pure presentation: colour codes, symbols, and padding, nothing that knows
 * about game state or domain rules.
 */

import type { Card } from "@yaniv/shared";

export const SUIT_SYMBOL: Record<string, string> = {
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
  spades: "♠",
};

export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
export const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
export const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
export const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/** Pad to a *visible* width — padEnd would miscount the colour escapes. */
export function pad(text: string, width: number): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "").length;
  return text + " ".repeat(Math.max(0, width - visible));
}

export function renderCard(card: Card): string {
  if (card.suit === null) return bold("Jk");
  const face = `${card.rank}${SUIT_SYMBOL[card.suit]}`;
  return card.suit === "hearts" || card.suit === "diamonds" ? red(face) : face;
}

export const renderHand = (cards: readonly Card[]) =>
  cards.map(renderCard).join(" ");
