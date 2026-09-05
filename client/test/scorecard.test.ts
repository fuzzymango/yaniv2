/**
 * The scorecard module: what a cell is coloured for, and what the grid a card is drawn
 * from actually holds.
 *
 * Pure and total, like `score.ts` and `seating.ts` beside it — a ledger and a roster in, a
 * grid out. Both behaviours live here rather than in the component for this client's
 * standing reason: components are not tested at all, so "blue beats the call" and "a seat that
 * was out of the match by then leaves a blank" have to be facts something can assert.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlayerGameView, RoundScore } from "@yaniv/shared";
import { cellTone, scorecardGrid } from "../src/scorecard.ts";
import { viewOf } from "./helpers.ts";

/** One round of a two-player ledger, with only what a test is actually saying named. */
function round(
  roundNumber: number,
  callerId: string,
  assaferId: string | null,
  totals: Record<string, [total: number, reduction?: number]>,
): RoundScore {
  return {
    roundNumber,
    callerId,
    assaferId,
    players: Object.entries(totals).map(([playerId, [scoreAfter, reduction]]) => ({
      playerId,
      scoreAfter,
      milestoneReduction: reduction ?? 0,
    })),
  };
}

/** The same view every suite here reads, with a ledger behind it. */
function ledger(scorecard: RoundScore[]): PlayerGameView {
  return { ...viewOf([], []), scorecard };
}

describe("cellTone", () => {
  it("marks the seat that called Yaniv", () => {
    const row = round(1, "p1", null, { p1: [0], p2: [12] });
    assert.equal(cellTone(row, row.players[0]!), "yaniv");
  });

  it("marks the seat that made the Assaf", () => {
    // Red is the Assafer's, not the caller's: the colours are a legend of what happened
    // rather than a verdict on who did well, and the two can never be the same seat.
    const row = round(4, "p1", "p2", { p1: [37], p2: [0] });
    assert.equal(cellTone(row, row.players[1]!), "assaf");
  });

  it("leaves a seat that did neither with no tone at all", () => {
    const row = round(4, "p1", "p2", { p1: [37], p2: [0], p3: [22] });
    assert.equal(cellTone(row, row.players[2]!), null);
  });

  it("marks a total a milestone cut", () => {
    const row = round(6, "p1", null, { p1: [0], p2: [50, 50] });
    assert.equal(cellTone(row, row.players[1]!), "milestone");
  });

  /**
   * The one collision the rules allow, and the whole reason this is a tested function: an
   * Assafed caller pays their hand plus the penalty, which can land on a multiple of 50.
   * Blue wins — the red cell in the same row already says an Assaf happened and only the
   * caller can be Assafed, while nothing else on the card explains a total going down.
   */
  it("gives blue to an Assafed caller who also hit a milestone", () => {
    const row = round(6, "p1", "p2", { p1: [0, 50], p2: [12] });
    assert.equal(cellTone(row, row.players[0]!), "milestone");
  });

  /** Red and blue cannot collide: the Assafer's delta is 0, and a reduction needs one above 0. */
  it("gives a round that stood exactly one toned cell", () => {
    const row = round(2, "p2", null, { p1: [12], p2: [0], p3: [30] });
    const toned = row.players.filter((cell) => cellTone(row, cell) !== null);

    assert.deepEqual(
      toned.map((cell) => cell.playerId),
      ["p2"],
    );
  });
});

describe("scorecardGrid", () => {
  it("heads a column with every seat's name, in the room's seating order", () => {
    const view: PlayerGameView = {
      ...ledger([]),
      // Turn order has moved on without p1; the card is not drawn from it.
      turnOrder: ["p2"],
    };

    assert.deepEqual(scorecardGrid(view).columns, [
      { playerId: "p1", name: "Ada" },
      { playerId: "p2", name: "Grace" },
    ]);
  });

  it("gives an empty ledger its columns and no rows at all", () => {
    // The first round of a match: the control is there and the card opens on the names,
    // rather than appearing out of nowhere partway through the game.
    const grid = scorecardGrid(ledger([]));

    assert.equal(grid.columns.length, 2);
    assert.deepEqual(grid.rows, []);
  });

  it("lays a row out in the columns' order, oldest round first", () => {
    const grid = scorecardGrid(
      ledger([
        round(1, "p2", null, { p2: [0], p1: [11] }),
        round(2, "p1", null, { p1: [11], p2: [9] }),
      ]),
    );

    assert.deepEqual(
      grid.rows.map((row) => row.roundNumber),
      [1, 2],
    );
    assert.deepEqual(grid.rows[0]!.cells, [
      { played: true, total: 11, tone: null },
      { played: true, total: 0, tone: "yaniv" },
    ]);
  });

  /** A blank cell means one thing: that seat was out of the match by that round. */
  it("leaves an explicit absence where a seat has no cell in a round", () => {
    const grid = scorecardGrid(
      ledger([round(5, "p2", null, { p2: [0] })]),
    );

    assert.deepEqual(grid.rows[0]!.cells, [
      { played: false },
      { played: true, total: 0, tone: "yaniv" },
    ]);
  });

  /**
   * A seat given up is still in the roster, which is append-only from the first deal — so
   * the record of the match they played is not erased by their leaving.
   */
  it("keeps a column, and its earlier rows, for a seat that has since left", () => {
    const view = ledger([
      round(1, "p1", null, { p1: [0], p2: [14] }),
      round(2, "p2", null, { p2: [14] }),
    ]);
    const gone = {
      ...view,
      opponents: [{ ...view.opponents[0]!, outInRound: null }],
      you: { ...view.you, outInRound: 1, departed: true },
      turnOrder: ["p2"],
    } as PlayerGameView;

    const grid = scorecardGrid(gone);

    assert.deepEqual(grid.columns[0], { playerId: "p1", name: "Ada" });
    assert.deepEqual(grid.rows[0]!.cells[0], { played: true, total: 0, tone: "yaniv" });
    assert.deepEqual(grid.rows[1]!.cells[0], { played: false });
  });
});
