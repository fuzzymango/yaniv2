/**
 * The match's ledger as a card to read: what each cell is coloured for, and the grid the
 * panel is drawn from.
 *
 * Pure and total, like `score.ts` beside it, and deliberately not part of it: that module
 * is scoped to one round result and a viewer, and produces sentences addressed to somebody
 * ("You called Yaniv"). This takes a list of rounds and a roster and produces a grid
 * addressed to nobody — the same document on every screen at the table, which is the whole
 * point of a scorecard (docs/adr/0017).
 *
 * The two things here are the two a component must not be trusted with, components in this
 * client being untested: which colour a cell wears where two rules apply at once, and what
 * a *blank* cell is. The absence is produced here, explicitly, rather than by a renderer
 * finding no entry and drawing nothing — the two look identical on the screen and are not
 * the same claim.
 */

import type {
  PlayerGameView,
  PlayerRoundScore,
  RoundScore,
} from "@yaniv/shared";
import { bySeat } from "./seating.ts";

/**
 * What one cell is marked for, or nothing. Named for what happened rather than for the
 * colour it is drawn in: which is yellow is the stylesheet's business, and a tone called
 * `yellow` would have to be renamed the day the palette moves — as one called `green` would
 * have had to be when the call went yellow (issue #156).
 *
 * `yaniv` is the seat that called, `assaf` the seat that took the call off them, and
 * `milestone` a total the round cut by 50 (docs/rules.md §7).
 */
export type CellTone = "yaniv" | "assaf" | "milestone" | null;

/**
 * One seat's box in one row: the total the round left them on, or the explicit fact that
 * they were not in the match to be left on one.
 *
 * Tagged rather than a nullable total, on the same grounds as every other tagged shape
 * here: a blank cell means one thing only, and "0 points" and "not playing" must not be
 * the same absence for a renderer to disambiguate.
 */
export type ScorecardCell =
  | { played: false }
  | { played: true; total: number; tone: CellTone };

/** One column: a seat of the room, headed by the name it is known by. */
export interface ScorecardColumn {
  playerId: string;
  name: string;
}

/** One row: a round, led by its number, with a cell per column in the columns' order. */
export interface ScorecardRow {
  roundNumber: number;
  cells: ScorecardCell[];
}

export interface ScorecardGrid {
  columns: ScorecardColumn[];
  rows: ScorecardRow[];
}

/**
 * What one cell is marked for.
 *
 * **Blue beats the call**, and that is the only precedence there is to state. The call/red
 * pair answers "what happened in this round", and the row answers it either way — a red
 * cell means somebody was Assafed, and only the caller can be. Blue answers a different
 * question, "why did this number go down", and nothing else on the card answers it at all.
 *
 * Red and blue cannot collide by the rules rather than by this ordering: the Assafer's
 * delta is always 0, and a reduction requires one above 0. The call and red cannot either —
 * the caller and the Assafer are never the same seat.
 */
export function cellTone(row: RoundScore, cell: PlayerRoundScore): CellTone {
  if (cell.milestoneReduction > 0) return "milestone";
  if (cell.playerId === row.callerId) return "yaniv";
  if (cell.playerId === row.assaferId) return "assaf";
  return null;
}

/**
 * The whole card: the room's seats as columns, the match's scored rounds as rows.
 *
 * Columns come off the **roster** (`view.seating`) and never `turnOrder`, for the reason
 * the table's own seating does (issue #144): turn order shrinks as players are eliminated,
 * so a card headed by it would drop a column mid-match and slide the rest along — and the
 * rows underneath still hold cells for the seat it dropped. The roster is append-only from
 * the first deal, so a player who has since left keeps their column and the rounds they
 * played keep their numbers.
 *
 * Names come off the roster too, rather than from the rows: a scorecard row deliberately
 * carries none (docs/adr/0017), the card being drawn from the seats already.
 */
export function scorecardGrid(view: PlayerGameView): ScorecardGrid {
  const columns: ScorecardColumn[] = [view.you, ...view.opponents]
    .sort(bySeat(view))
    .map((seat) => ({ playerId: seat.id, name: seat.name }));

  const rows: ScorecardRow[] = view.scorecard.map((row) => ({
    roundNumber: row.roundNumber,
    cells: columns.map((column) => {
      const cell = row.players.find((p) => p.playerId === column.playerId);
      // No cell is not a missing number: that seat was out of the match when this round
      // was dealt, and the blank on the card says exactly when they stopped playing.
      if (!cell) return { played: false };
      return { played: true, total: cell.scoreAfter, tone: cellTone(row, cell) };
    }),
  }));

  return { columns, rows };
}
