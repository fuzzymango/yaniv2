/**
 * The score module: what a scored round says, on a seat's label and above the felt.
 *
 * Pure and total, like `fan.ts` and `seating.ts` beside it — a round in, asserted as a
 * string. Two properties are worth more than any single case: that the label reads as an
 * equation a player can check for themselves, whatever the round did to them, and who the
 * outcome is addressed to, since the same round is a different sentence on every screen it
 * lands on (issue #78).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RoundResultView } from "@yaniv/shared";
import { roundOutcome, scoreLabel } from "../src/score.ts";

describe("scoreLabel", () => {
  it("reads as the round's own arithmetic: where they started, what it did, where they are", () => {
    assert.equal(scoreLabel(53, 21), "32 + 21 = 53 pts");
  });

  it("flips the operator for a round that took points off, rather than adding a sign", () => {
    // `18 + -12 = 6` is an equation nobody reads at a glance; the minus belongs in the
    // operator, where a player already expects to find it.
    assert.equal(scoreLabel(6, -12), "18 - 12 = 6 pts");
  });

  it("states a round that changed nothing in the same shape as every other", () => {
    // No special case for the winner: the equation is what says a round happened at all,
    // so `32 + 0 = 32` is worth more than a bare total that could be any round's.
    assert.equal(scoreLabel(32, 0), "32 + 0 = 32 pts");
  });

  it("absorbs a milestone reduction into the delta rather than noting it apart", () => {
    // 195 + 55 landed exactly on 250, which gave 50 back (docs/rules.md §7) — so what the
    // round actually did was +5, and the equation says exactly that and nothing else.
    assert.equal(scoreLabel(200, 55, 50), "195 + 5 = 200 pts");
  });

  it("turns the operator round when the reduction outweighs the round's own delta", () => {
    // 240 + 10 landed on 250 too, and that same 50 back is more than the round ever added:
    // a player can end a round lower than they started it having gained points in it.
    assert.equal(scoreLabel(200, 10, 50), "240 - 40 = 200 pts");
  });

  it("says the same thing about the same round wherever it is read", () => {
    // One function for every seat's label and for the viewer's own footer, so a player
    // cannot be told two different things about one round depending on where they sit.
    // Spelled out rather than derived: a test that recomputed `scoreBefore` the way the
    // label does would pass a label that derived it wrongly, twice.
    const rounds: [[number, number, number], string][] = [
      [[0, 0, 0], "0 + 0 = 0 pts"],
      [[7, 7, 0], "0 + 7 = 7 pts"],
      [[104, 30, 0], "74 + 30 = 104 pts"],
      [[50, -50, 0], "100 - 50 = 50 pts"],
      [[200, 55, 50], "195 + 5 = 200 pts"],
    ];
    for (const [[score, delta, milestoneReduction], said] of rounds) {
      assert.equal(scoreLabel(score, delta, milestoneReduction), said);
      // The equation opens on where the round started — the one number the label is not
      // handed — and closes on the total, which is where the player now stands.
      assert.ok(said.endsWith(`= ${score} pts`));
    }
  });

  it("reads the same as a round with no reduction when nothing was reduced", () => {
    assert.equal(scoreLabel(32, 21, 0), scoreLabel(32, 21));
    assert.equal(scoreLabel(32, 21), "11 + 21 = 32 pts");
  });
});

/** A round, cut down to the fields `roundOutcome` reads. Hands and numbers play no part. */
const round = (
  callerId: string,
  assaferId: string | null,
  names: Record<string, string>,
): RoundResultView => ({
  roundNumber: 1,
  callerId,
  assaferId,
  winnerId: assaferId ?? callerId,
  players: Object.entries(names).map(([playerId, name]) => ({
    playerId,
    name,
    hand: [],
    handValue: 0,
    delta: 0,
    milestoneReduction: 0,
    scoreAfter: 0,
  })),
});

const table = { you: "You-ish", rival: "Rival" };

describe("roundOutcome", () => {
  it("names the caller and says the call stood", () => {
    assert.equal(
      roundOutcome(round("rival", null, table), "you"),
      "Rival called Yaniv — it stood.",
    );
  });

  it("names whoever Assafed it, since that is why the round ended as it did", () => {
    assert.equal(
      roundOutcome(round("rival", "other", { ...table, other: "Other" }), "you"),
      "Rival called Yaniv — Assafed by Other.",
    );
  });

  it("addresses the viewer rather than reading their own name back at them", () => {
    assert.equal(
      roundOutcome(round("you", null, table), "you"),
      "You called Yaniv — it stood.",
    );
  });

  it("says the viewer Assafed it in the same voice, as the object of the sentence", () => {
    assert.equal(
      roundOutcome(round("rival", "you", table), "you"),
      "Rival called Yaniv — Assafed by you.",
    );
  });

  it("says a viewer who called and was Assafed both ways round in one sentence", () => {
    assert.equal(
      roundOutcome(round("you", "rival", table), "you"),
      "You called Yaniv — Assafed by Rival.",
    );
  });

  it("still reads as a sentence when the round has no record of the player", () => {
    // A raw player id is a wire token, not somebody's name, and must never reach a screen.
    const said = roundOutcome(round("ghost", null, table), "you");
    assert.equal(said, "Somebody called Yaniv — it stood.");
    assert.ok(!said.includes("ghost"));
  });

  it("names a seat given up since, off the round's own record", () => {
    // The whole reason names are read from `result.players` rather than the live roster: a
    // player who has left is in no roster to be looked up in.
    assert.equal(
      roundOutcome(round("gone", null, { ...table, gone: "Departed" }), "you"),
      "Departed called Yaniv — it stood.",
    );
  });
});
