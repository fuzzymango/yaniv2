/**
 * One badge on a seat's nameplate (spec #293): a 12px icon in a small round chip, saying one
 * thing about the player behind the seat — out, away, left, watching or a bot.
 *
 * Which badges a seat wears, and in what order, is `seatBadges`'s (`status.ts`); this draws one
 * it is handed. The icons are the design's 24-unit paths, hand-written inline SVG in
 * `currentColor`, so the chip's own colour is the icon's (`.seat-badge--away` is the orange one).
 *
 * An icon is not a word, so the chip carries one: an `img` role named in words for a screen
 * reader, and the same word as a `title` for a pointer. The SVG inside it is decoration.
 */

import type { ReactNode } from "react";
import type { Badge } from "../status.ts";

/** The word each badge stands for — what a screen reader says, and a pointer is shown. */
const BADGE_LABEL: Record<Badge, string> = {
  out: "out",
  away: "away",
  left: "left",
  watching: "watching",
  bot: "bot",
};

/** The design's 24-unit icons, drawn in `currentColor`. */
const icon = (body: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {body}
  </svg>
);

const BADGE_ICON: Record<Badge, ReactNode> = {
  // A card, crossed out.
  out: icon(
    <>
      <rect x="5.5" y="3" width="13" height="18" rx="2" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </>,
  ),
  // Wifi, with a slash through it.
  away: icon(
    <>
      <path d="M2 8.8a15 15 0 0 1 20 0" />
      <path d="M5 12.6a10 10 0 0 1 14 0" />
      <path d="M8.5 16.3a5 5 0 0 1 7 0" />
      <circle cx="12" cy="20" r="1.4" fill="currentColor" stroke="none" />
      <path d="M3 3l18 18" />
    </>,
  ),
  // A door, with an arrow leaving through it.
  left: icon(
    <>
      <path d="M13 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H13" />
      <path d="M10 12h11M17 8l4 4-4 4" />
    </>,
  ),
  // An eye.
  watching: icon(
    <>
      <path d="M2.5 12C5 7.3 8.2 5.5 12 5.5s7 1.8 9.5 6.5c-2.5 4.7-5.7 6.5-9.5 6.5S5 16.7 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" fill="currentColor" stroke="none" />
    </>,
  ),
  // A robot's head.
  bot: icon(
    <>
      <rect x="4.5" y="8" width="15" height="11.5" rx="3" />
      <path d="M12 8V4.5" />
      <circle cx="12" cy="3.6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9.3" cy="13.6" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="13.6" r="1.5" fill="currentColor" stroke="none" />
    </>,
  ),
};

export function SeatBadge({ badge }: { badge: Badge }) {
  const label = BADGE_LABEL[badge];
  return (
    <span className={`seat-badge seat-badge--${badge}`} role="img" aria-label={label} title={label}>
      {BADGE_ICON[badge]}
    </span>
  );
}
