/**
 * [PROTOTYPE — issue #56] The shape both `Table` (face-down, live) and `RoundEnd`
 * (face-up, revealed) reduce a player down to, so the three seat-layout variants can
 * render either screen without knowing which one they're on.
 */

import type { Card } from "@yaniv/shared";

export interface SeatEntry {
  id: string;
  name: string;
  score: number;
  isTurn: boolean;
  /** Number of card backs to fan, when `cards` is absent (live play). */
  cardCount: number;
  /** The actual revealed cards, face-up, at `roundEnd`. Absent during live play. */
  cards?: Card[];
  marks?: string[];
  delta?: number;
  handValue?: number;
}
