/**
 * Whether a scored round has a milestone count to play, whose seats it counts at, and what
 * each of their lines says at any moment of it.
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
import type {
  PlayerGameView,
  PlayerRoundResultView,
  PlayerRoundScore,
  RoundResultView,
  RoundScore,
} from "@yaniv/shared";
import { countFrame, countdownFrom } from "../src/milestone.ts";
import { scoreLabel } from "../src/score.ts";
import { MILESTONE_COUNT_MS } from "../src/timing.ts";
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

/**
 * One seat's revealed line: stood on `before`, caught holding `delta`, and a milestone taking
 * 50 back where the total landed on one. `wentOut` is the caller's to say, as `Table` does.
 */
const revealed = (before: number, delta: number): PlayerRoundResultView => {
  const landed = before + delta;
  const milestoneReduction = delta > 0 && landed % 50 === 0 ? 50 : 0;
  return {
    playerId: "p2",
    name: "Grace",
    hand: cards("spades-9"),
    handValue: delta,
    delta,
    milestoneReduction,
    scoreAfter: landed - milestoneReduction,
  };
};

/** Every whole millisecond of a count, and a little either side of it. */
const throughTheCount = Array.from({ length: MILESTONE_COUNT_MS + 201 }, (_, i) => i - 100);

describe("countFrame", () => {
  // The spec's own example: on 20, caught holding 30, so 50 and back to 0.
  const ada = revealed(20, 30);

  describe("the label", () => {
    it("is unfolded at the start: where they stood, the round's raw points, the multiple landed on", () => {
      assert.deepEqual(countFrame(ada, false, 0), {
        stage: "counting",
        total: 50,
        label: "20 + 30 = 50 pts",
        outShown: false,
      });
    });

    it("is unfolded and unmoved before the start — a frame stamped a moment before the latch", () => {
      // A frame's timestamp is when the frame began, which can be a hair before the table
      // latched the count; it reads as the count's first moment, never as a value past it.
      assert.equal(countFrame(ada, false, -16).label, "20 + 30 = 50 pts");
      assert.equal(countFrame(ada, false, -Infinity).total, 50);
    });

    it("drains halfway at half the count, with the fixed part of the sentence unchanged", () => {
      assert.equal(countFrame(ada, false, MILESTONE_COUNT_MS / 2).label, "20 + 30 = 25 pts");
    });

    it("drains a total of integers, never rising, from the multiple to where the round left it", () => {
      const totals = throughTheCount.map((ms) => countFrame(ada, false, ms).total);
      for (const total of totals) assert.ok(Number.isInteger(total), `${total} is a whole number`);
      for (let i = 1; i < totals.length; i += 1) {
        assert.ok(totals[i]! <= totals[i - 1]!, `${totals[i]} after ${totals[i - 1]}`);
      }
      assert.equal(totals[0], 50);
      assert.equal(totals[totals.length - 1], 0);
    });

    it("is exactly where the round left them at the count's length and beyond", () => {
      for (const ms of [MILESTONE_COUNT_MS, MILESTONE_COUNT_MS + 1, 60_000, Infinity]) {
        assert.equal(countFrame(ada, false, ms).total, ada.scoreAfter);
        assert.equal(countFrame(ada, false, ms).stage, "landed");
      }
      assert.equal(countFrame(ada, false, MILESTONE_COUNT_MS - 1).stage, "counting");
    });

    it("lands on the folded sentence every other scored line reads", () => {
      // The landing is one frame from the count to today's label, not a third wording.
      for (const player of [ada, revealed(195, 55), revealed(70, 30)]) {
        assert.equal(
          countFrame(player, false, MILESTONE_COUNT_MS).label,
          scoreLabel(player.scoreAfter, player.delta, player.milestoneReduction),
        );
      }
    });

    it("drains a total landed on a later multiple to the one below it", () => {
      const mid = revealed(195, 55); // 250, back to 200
      assert.equal(countFrame(mid, false, 0).label, "195 + 55 = 250 pts");
      assert.equal(countFrame(mid, false, MILESTONE_COUNT_MS).label, "195 + 5 = 200 pts");
    });

    it("has nothing to count on a line no milestone touched", () => {
      // Total over every line, so a seat that is not counting cannot be drawn as one.
      const plainLine = revealed(10, 7);
      assert.deepEqual(countFrame(plainLine, false, 0), {
        stage: "landed",
        total: 17,
        label: scoreLabel(17, 7, 0),
        outShown: false,
      });
    });
  });

  describe("going out", () => {
    // On 195, caught holding 55: landed on 250, the milestone takes it to 200, still past 100.
    const outOnMilestone = revealed(195, 55);

    it("is withheld for the whole count from a seat the round took out", () => {
      for (const ms of throughTheCount.filter((ms) => ms < MILESTONE_COUNT_MS)) {
        assert.equal(countFrame(outOnMilestone, true, ms).outShown, false, `at ${ms}ms`);
      }
    });

    it("is shown the moment the count lands, and from then on", () => {
      assert.equal(countFrame(outOnMilestone, true, MILESTONE_COUNT_MS).outShown, true);
      assert.equal(countFrame(outOnMilestone, true, Infinity).outShown, true);
    });

    it("is shown at once on a seat that went out with no milestone to count", () => {
      assert.equal(countFrame(revealed(90, 27), true, 0).outShown, true);
    });

    it("is never shown on a seat the milestone saved", () => {
      // On 120, caught holding 30: 150 back to 100, which is not past the limit.
      const saved = revealed(120, 30);
      for (const ms of throughTheCount) assert.equal(countFrame(saved, false, ms).outShown, false);
    });
  });
});
