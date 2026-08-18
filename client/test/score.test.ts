/**
 * The score module: what a scored round says, on a seat's label and above the felt.
 *
 * Pure and total, like `fan.ts` and `seating.ts` beside it — a round in, asserted as a
 * string. Two properties are worth more than any single case: the delta's sign, since a
 * round that added nothing has to read as a round rather than a second copy of the total,
 * and who the outcome is addressed to, since the same round is a different sentence on
 * every screen it lands on (issue #78).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RoundResultView } from "@yaniv/shared";
import { roundOutcome, scoreLabel } from "../src/score.ts";

describe("scoreLabel", () => {
  it("leads with the total, since that is what says where a player stands", () => {
    assert.ok(scoreLabel(32, 21).startsWith("32"));
  });

  it("says what the round added, alongside the total it made", () => {
    assert.equal(scoreLabel(32, 21), "32 pts (+21)");
  });

  it("signs a round that added nothing, so it cannot be read as a second total", () => {
    assert.equal(scoreLabel(32, 0), "32 pts (+0)");
    assert.notEqual(scoreLabel(0, 0), "0 pts (0)");
  });

  it("carries a negative round's own sign rather than adding one", () => {
    assert.equal(scoreLabel(18, -12), "18 pts (-12)");
  });

  it("says the same thing about the same round wherever it is read", () => {
    // One function for every seat's label and for the viewer's own footer, so a player
    // cannot be told two different things about one round depending on where they sit.
    const rounds: [number, number][] = [
      [0, 0],
      [7, 7],
      [104, 30],
      [50, -50],
    ];
    for (const [score, delta] of rounds) {
      assert.equal(scoreLabel(score, delta), scoreLabel(score, delta));
      assert.ok(scoreLabel(score, delta).includes(`${score}`));
    }
  });

  it("notes a milestone reduction beside the raw delta, so the total doesn't look wrong", () => {
    // 200 + 55 landed on 255, which crossed a milestone and gave back 50 — the total
    // reads as 50 lower than the raw delta alone would suggest, so the note has to say why.
    assert.equal(scoreLabel(205, 55, 50), "205 pts (+55, -50 milestone)");
  });

  it("adds no note at all when nothing was reduced", () => {
    assert.equal(scoreLabel(32, 21, 0), scoreLabel(32, 21));
    assert.equal(scoreLabel(32, 21), "32 pts (+21)");
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
