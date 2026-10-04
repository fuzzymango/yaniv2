/**
 * What the client announces when a round is scored, given the position it was showing and
 * the one that has just arrived.
 *
 * Pure fixtures in, an ordered list of banners or nothing out — the same shape as
 * `flight.test.ts`, and for the same reason: this is the whole of the automated seam for
 * the call announcement (issue #156). Nothing about pixels, timing or the DOM is decided
 * here, so nothing about them is asserted here either.
 *
 * The cases that matter most are the ones about *freshness*: several independent paths
 * republish a scored round, and a naive trigger would announce on all of them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlayerGameView, RoundResultView, RoundScore } from "@yaniv/shared";
import { announcementFrom, bannerAt } from "../src/announcement.ts";
import { cards, viewOf } from "./helpers.ts";

/** A scorecard row for a round, named by who called it and who took it off them. */
const row = (roundNumber: number, callerId: string, assaferId: string | null): RoundScore => ({
  roundNumber,
  callerId,
  assaferId,
  players: [
    { playerId: "p1", scoreAfter: 10, milestoneReduction: 0 },
    { playerId: "p2", scoreAfter: 20, milestoneReduction: 0 },
  ],
});

/** The same round as the reveal beside it, which is what the table is actually drawing. */
const reveal = (roundNumber: number, callerId: string, assaferId: string | null): RoundResultView => ({
  roundNumber,
  callerId,
  assaferId,
  winnerId: assaferId ?? callerId,
  players: [
    { playerId: "p1", name: "Ada", hand: cards("hearts-5"), handValue: 5, delta: 0, milestoneReduction: 0, scoreAfter: 10 },
    { playerId: "p2", name: "Grace", hand: cards("spades-9"), handValue: 9, delta: 9, milestoneReduction: 0, scoreAfter: 20 },
  ],
});

/** A position mid-round: nothing scored, nothing revealed. */
const playing = (scorecard: RoundScore[] = []): PlayerGameView => ({
  ...viewOf(cards("hearts-5"), cards("clubs-7")),
  scorecard,
});

/** A position with a round on the table, scored and revealed. */
const scored = (
  scorecard: RoundScore[],
  result: RoundResultView,
  phase: "roundEnd" | "gameEnd" = "roundEnd",
): PlayerGameView => ({
  ...playing(scorecard),
  phase,
  roundResult: result,
});

describe("announcementFrom", () => {
  it("announces the caller when the call stood", () => {
    const before = playing();
    const after = scored([row(1, "p2", null)], reveal(1, "p2", null));

    assert.deepEqual(announcementFrom(before, after), [{ playerId: "p2", call: "yaniv", text: "YANIV" }]);
  });

  it("announces the call first and the Assaf second", () => {
    const before = playing();
    const after = scored([row(1, "p1", "p2")], reveal(1, "p1", "p2"));

    assert.deepEqual(announcementFrom(before, after), [
      { playerId: "p1", call: "yaniv", text: "YANIV" },
      { playerId: "p2", call: "assaf", text: "ASSAF" },
    ]);
  });

  it("orders the pair by what happened, whichever seat the record names first", () => {
    // The record has no order to it — the pair is built from two named fields — so this
    // is here to fail if the construction is ever replaced by a scan of the players.
    const before = playing();
    const after = scored([row(1, "p2", "p1")], reveal(1, "p2", "p1"));

    const announced = announcementFrom(before, after);
    assert.equal(announced?.[0]?.call, "yaniv");
    assert.equal(announced?.[0]?.playerId, "p2");
    assert.equal(announced?.[1]?.call, "assaf");
    assert.equal(announced?.[1]?.playerId, "p1");
  });

  it("announces nothing while a round is still being played", () => {
    assert.equal(announcementFrom(playing(), playing()), null);
  });

  it("announces nothing when no round has been scored", () => {
    const after = scored([], reveal(1, "p2", null));
    assert.equal(announcementFrom(playing(), after), null);
  });

  it("announces nothing on a republish of the same scored round", () => {
    // A disconnect, a departure or a seat resumed all republish the room, and the round on
    // the table is the same round. The scorecard has not grown, so nothing happened.
    const card = [row(1, "p2", null)];
    const shown = scored(card, reveal(1, "p2", null));
    const again = scored(card, reveal(1, "p2", null));

    assert.equal(announcementFrom(shown, again), null);
  });

  it("announces nothing for a match ended by a departure", () => {
    // `gameEnd` reached without a round being scored: the previous round's result is still
    // standing, and a trigger reading it would claim a call nobody made.
    const card = [row(1, "p2", null)];
    const shown = scored(card, reveal(1, "p2", null));
    const ended = scored(card, reveal(1, "p2", null), "gameEnd");

    assert.equal(announcementFrom(shown, ended), null);
  });

  it("announces the match-winning call at gameEnd", () => {
    const before = playing([row(1, "p2", null)]);
    const after = scored([row(1, "p2", null), row(2, "p1", null)], reveal(2, "p1", null), "gameEnd");

    assert.deepEqual(announcementFrom(before, after), [{ playerId: "p1", call: "yaniv", text: "YANIV" }]);
  });

  it("announces nothing on a position nobody watched arrive", () => {
    const after = scored([row(1, "p2", null)], reveal(1, "p2", null));
    assert.equal(announcementFrom(null, after), null);
  });

  it("never announces an empty list", () => {
    const announced = announcementFrom(playing(), scored([row(1, "p1", "p2")], reveal(1, "p1", "p2")));
    assert.ok(announced !== null);
    assert.ok(announced.length === 1 || announced.length === 2);
  });
});

/*
 * What each banner says (issue #238): the seat's own words for that kind of call where it
 * chose some, the banner's word where it did not. Who the seat is comes off the arriving
 * position's roster — the viewer's own seat included, since the caller may be the viewer.
 */
describe("the words a banner says", () => {
  /** An Assafed round arriving, with each seat's custom calls as given. */
  function assafed(
    you: { customYanivCall: string | null; customAssafCall: string | null },
    them: { customYanivCall: string | null; customAssafCall: string | null },
    callerId = "p1",
    assaferId = "p2",
  ) {
    const after = scored([row(1, callerId, assaferId)], reveal(1, callerId, assaferId));
    return announcementFrom(playing(), {
      ...after,
      you: { ...after.you, ...you },
      opponents: after.opponents.map((o) => ({ ...o, ...them })),
    });
  }

  const UNSET = { customYanivCall: null, customAssafCall: null };

  it("uses a seat's custom call where it has one, as it was typed", () => {
    const announced = assafed(
      { customYanivCall: "I win!", customAssafCall: null },
      { customYanivCall: null, customAssafCall: "Gotcha" },
    );

    assert.deepEqual(announced, [
      { playerId: "p1", call: "yaniv", text: "I win!" },
      { playerId: "p2", call: "assaf", text: "Gotcha" },
    ]);
  });

  it("falls back on the banner's own word where a seat has none", () => {
    assert.deepEqual(assafed(UNSET, UNSET), [
      { playerId: "p1", call: "yaniv", text: "YANIV" },
      { playerId: "p2", call: "assaf", text: "ASSAF" },
    ]);
  });

  it("reads the custom call for the kind of call made, never the other one", () => {
    // The caller chose only an Assaf call and the Assafer only a Yaniv call: neither is
    // what this round asked of them, so both banners say the banner's own word.
    const announced = assafed(
      { customYanivCall: null, customAssafCall: "Gotcha" },
      { customYanivCall: "I win!", customAssafCall: null },
    );

    assert.deepEqual(announced?.map((b) => b.text), ["YANIV", "ASSAF"]);
  });

  it("lets the kind and not the text decide which call a banner is", () => {
    // Words that name the other call are still this call's words: the colour a renderer
    // draws comes off `call`, so a red banner is an Assaf whatever it says.
    const announced = assafed(
      { customYanivCall: "ASSAF", customAssafCall: null },
      { customYanivCall: null, customAssafCall: "YANIV" },
    );

    assert.deepEqual(announced, [
      { playerId: "p1", call: "yaniv", text: "ASSAF" },
      { playerId: "p2", call: "assaf", text: "YANIV" },
    ]);
  });

  it("finds an opponent's seat as readily as the viewer's own", () => {
    const announced = assafed(
      { customYanivCall: null, customAssafCall: "Not today" },
      { customYanivCall: "Mine", customAssafCall: null },
      "p2",
      "p1",
    );

    assert.deepEqual(announced, [
      { playerId: "p2", call: "yaniv", text: "Mine" },
      { playerId: "p1", call: "assaf", text: "Not today" },
    ]);
  });

  it("hands the words on to the seat the banner goes over", () => {
    const announced = assafed(
      { customYanivCall: "I win!", customAssafCall: null },
      { customYanivCall: null, customAssafCall: "Gotcha" },
    );

    assert.deepEqual(bannerAt(announced, "p1"), { call: "yaniv", text: "I win!", index: 0, count: 2 });
    assert.deepEqual(bannerAt(announced, "p2"), { call: "assaf", text: "Gotcha", index: 1, count: 2 });
  });
});

describe("bannerAt", () => {
  const pair = announcementFrom(playing(), scored([row(1, "p1", "p2")], reveal(1, "p1", "p2")));
  const alone = announcementFrom(playing(), scored([row(1, "p1", null)], reveal(1, "p1", null)));

  it("places the call first and the Assaf second", () => {
    assert.deepEqual(bannerAt(pair, "p1"), { call: "yaniv", text: "YANIV", index: 0, count: 2 });
    assert.deepEqual(bannerAt(pair, "p2"), { call: "assaf", text: "ASSAF", index: 1, count: 2 });
  });

  it("gives a lone call a list of one to be last in", () => {
    assert.deepEqual(bannerAt(alone, "p1"), { call: "yaniv", text: "YANIV", index: 0, count: 1 });
  });

  it("has nothing for a seat the round did not turn on", () => {
    assert.equal(bannerAt(pair, "p3"), null);
    assert.equal(bannerAt(alone, "p2"), null);
  });

  it("has nothing at all when there is nothing to announce", () => {
    assert.equal(bannerAt(null, "p1"), null);
  });
});
