/**
 * Whether a scored round has a milestone count to play, and whose seats it counts at.
 *
 * Pure fixtures in, a count or nothing out — `announcement.test.ts`'s shape, and on purpose
 * its trigger: the count starts on exactly the publications the banners do (spec #280).
 * Nothing about pixels, frames or timing is decided by `countdownFrom`, so nothing about
 * them is asserted here either.
 *
 * As with the announcement, the cases that matter most are about *freshness*: a scored
 * round is republished by several paths, and a count read off anything but the scorecard
 * growing would start again on every one of them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlayerGameView, PlayerRoundScore, RoundResultView, RoundScore } from "@yaniv/shared";
import { countdownFrom } from "../src/milestone.ts";
import { cards, viewOf } from "./helpers.ts";

/** One seat's line in a scorecard row: where the round left it, and what a milestone took off. */
const line = (playerId: string, scoreAfter: number, milestoneReduction = 0): PlayerRoundScore => ({
  playerId,
  scoreAfter,
  milestoneReduction,
});

/** A scorecard row, named by who called it and who took it off them. */
const row = (
  roundNumber: number,
  players: PlayerRoundScore[],
  callerId = "p1",
  assaferId: string | null = null,
): RoundScore => ({ roundNumber, callerId, assaferId, players });

/** The rows a table is drawn from when nobody hit a milestone. */
const plain = (roundNumber: number): RoundScore => row(roundNumber, [line("p1", 10), line("p2", 20)]);

/**
 * The reveal standing beside a scorecard. Deliberately *not* the newest row: it is the
 * field a count must not be read from, so every fixture leaves it saying something else —
 * here, a milestone of its own — and a `countdownFrom` that reached for it would count it.
 */
const staleReveal: RoundResultView = {
  roundNumber: 1,
  callerId: "p1",
  assaferId: null,
  winnerId: "p1",
  players: [
    { playerId: "p1", name: "Ada", hand: cards("hearts-5"), handValue: 5, delta: 0, milestoneReduction: 0, scoreAfter: 10 },
    { playerId: "p2", name: "Grace", hand: cards("spades-9"), handValue: 30, delta: 30, milestoneReduction: 50, scoreAfter: 0 },
  ],
};

/** A position mid-round: nothing new scored. */
const playing = (scorecard: RoundScore[] = []): PlayerGameView => ({
  ...viewOf(cards("hearts-5"), cards("clubs-7")),
  scorecard,
});

/** A position with a round on the table, scored and revealed. */
const scored = (scorecard: RoundScore[], phase: "roundEnd" | "gameEnd" = "roundEnd"): PlayerGameView => ({
  ...playing(scorecard),
  phase,
  roundResult: staleReveal,
});

describe("countdownFrom", () => {
  describe("counts", () => {
    it("a lone milestone, from the multiple it landed on to where the round left it", () => {
      const after = scored([row(1, [line("p1", 10), line("p2", 0, 50)])]);

      assert.deepEqual(countdownFrom(playing(), after), {
        round: 1,
        seats: [{ playerId: "p2", landedOn: 50, settlesOn: 0 }],
      });
    });

    it("every milestone seat at once, the viewer's own included, in the row's order", () => {
      const before = playing([plain(1)]);
      const after = scored([
        plain(1),
        row(2, [line("p1", 50, 50), line("p2", 0, 50), line("p3", 37)]),
      ]);

      assert.deepEqual(countdownFrom(before, after), {
        round: 2,
        seats: [
          { playerId: "p1", landedOn: 100, settlesOn: 50 },
          { playerId: "p2", landedOn: 50, settlesOn: 0 },
        ],
      });
    });

    it("an Assafed caller who hit a milestone, under the banner that took the call off them", () => {
      const after = scored([row(1, [line("p1", 0, 50), line("p2", 0)], "p1", "p2")]);

      assert.deepEqual(countdownFrom(playing(), after), {
        round: 1,
        seats: [{ playerId: "p1", landedOn: 50, settlesOn: 0 }],
      });
    });

    it("the round that ends the match, at gameEnd", () => {
      // The phase is never asked: a milestone in the deciding round arrives as a `gameEnd`,
      // and a trigger that named `roundEnd` would leave it the one milestone never counted.
      const before = playing([plain(1)]);
      const after = scored([plain(1), row(2, [line("p1", 50, 50), line("p2", 104)])], "gameEnd");

      assert.deepEqual(countdownFrom(before, after), {
        round: 2,
        seats: [{ playerId: "p1", landedOn: 100, settlesOn: 50 }],
      });
    });
  });

  describe("null", () => {
    it("on a position nobody watched arrive — a cold boot or a seat claimed back", () => {
      const after = scored([row(1, [line("p1", 10), line("p2", 0, 50)])]);
      assert.equal(countdownFrom(null, after), null);
    });

    it("on a republication of the same scored round", () => {
      // A drop, a reconnect or a departure that leaves the match going all republish the
      // round on the table. The scorecard has not grown, so nothing has been scored.
      const card = [row(1, [line("p1", 10), line("p2", 0, 50)])];
      assert.equal(countdownFrom(scored(card), scored(card)), null);
    });

    it("on a deal", () => {
      const card = [row(1, [line("p1", 10), line("p2", 0, 50)])];
      assert.equal(countdownFrom(scored(card), playing(card)), null);
    });

    it("on a match ended by a departure", () => {
      // `gameEnd` with no round scored to reach it: the last row and the reveal beside it
      // are both still standing, and neither is news.
      const card = [row(1, [line("p1", 10), line("p2", 0, 50)])];
      assert.equal(countdownFrom(scored(card), scored(card, "gameEnd")), null);
    });

    it("on a round nobody hit a milestone in", () => {
      assert.equal(countdownFrom(playing([plain(1)]), scored([plain(1), plain(2)])), null);
    });

    it("on a round in which the reveal beside the scorecard has a milestone and the row does not", () => {
      // Content and trigger come off the one row. The reveal fixture carries a milestone
      // for p2; the row scored here does not, so there is nothing to count.
      assert.equal(countdownFrom(playing(), scored([plain(1)])), null);
    });
  });
});
