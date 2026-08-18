/**
 * What the client decides is worth animating, given the position it was showing and the
 * one that has just arrived.
 *
 * Pure fixtures in, a description of a move or nothing out — the same shape as
 * `turn.test.ts`, and for the same reason: this is the whole of the automated seam for the
 * card flight (issue #69). Nothing about pixels, timing or the DOM is decided here, so
 * nothing about them is asserted here either.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlayerGameView } from "@yaniv/shared";
import type { TurnFlight } from "../src/flight.ts";
import { flightFrom } from "../src/flight.ts";
import { card, cards, viewOf } from "./helpers.ts";

/**
 * A mid-round position, built on the same fixture the turn tests use so the two suites
 * agree on what an ordinary table looks like. Only what this module reads is ever named:
 * the phase, the round number, the discard, and the move that produced them.
 */
const position = (overrides: Partial<PlayerGameView> = {}): PlayerGameView => ({
  ...viewOf(cards("hearts-5", "spades-9"), cards("clubs-7")),
  ...overrides,
});

/**
 * The turn between two positions, narrowed to the shape the case is about. Every case below
 * that reads a field of a flight is about a discard-and-draw, and nothing there — a slapdown,
 * or no flight at all — is the case failing rather than something to assert around.
 */
const turnBetween = (shown: PlayerGameView, arriving: PlayerGameView): TurnFlight => {
  const flight = flightFrom(shown, arriving);
  assert.ok(flight !== null && flight.kind === "turn", "a turn was expected");
  return flight;
};

describe("flightFrom", () => {
  it("describes the turn that produced the arriving position", () => {
    const before = position();
    const after = position({
      lastDiscard: cards("hearts-5"),
      lastMove: { playerId: "p2", drawSource: "deck", drawnCard: null },
    });

    assert.deepEqual(flightFrom(before, after), {
      kind: "turn",
      playerId: "p2",
      discarded: cards("hearts-5"),
      drawSource: "deck",
      drawnCard: null,
    });
  });

  it("carries every card of a set discarded at once", () => {
    const before = position();
    const after = position({
      lastDiscard: cards("hearts-5", "clubs-5", "spades-5"),
      lastMove: { playerId: "p2", drawSource: "deck", drawnCard: null },
    });

    assert.deepEqual(
      turnBetween(before, after).discarded,
      cards("hearts-5", "clubs-5", "spades-5"),
      "three cards leaving one hand are one move, not three",
    );
  });

  it("names the one card a single-card pile could have offered", () => {
    const before = position({ lastDiscard: cards("hearts-6") });
    const after = position({
      lastDiscard: cards("spades-9"),
      lastMove: { playerId: "p2", drawSource: "discard", drawnCard: card("hearts-6") },
    });

    // Nothing is inferred even where there is only one thing it could be: the field the
    // server sent is the answer in every case, so there is no second way of arriving at it
    // to disagree with the first.
    assert.deepEqual(turnBetween(before, after).drawnCard, card("hearts-6"));
  });

  it("names the card taken off the pile rather than working it out", () => {
    // Both ends of a run are pickup-eligible and what is left of it reaches the client as
    // a count, so which end went is not recoverable by comparing the two positions — the
    // whole reason the server says so outright (ADR-0007).
    const before = position({ lastDiscard: cards("hearts-6", "hearts-7", "hearts-8") });
    const after = position({
      lastDiscard: cards("spades-9"),
      lastMove: { playerId: "p2", drawSource: "discard", drawnCard: card("hearts-8") },
    });

    const flight = turnBetween(before, after);
    assert.equal(flight.drawSource, "discard");
    assert.deepEqual(flight.drawnCard, card("hearts-8"));
  });

  it("shows the drawn card to whoever the server showed it to", () => {
    // The redaction is the server's and this module passes it on: a card off the deck is
    // the mover's alone, and a viewer who was not told which it was is the one who draws a
    // back flying rather than a face.
    const before = position();
    const off = { playerId: "p1", drawSource: "deck" } as const;

    const toTheMover = position({
      lastMove: { ...off, drawnCard: card("diamonds-4") },
    });
    const toEverybodyElse = position({ lastMove: { ...off, drawnCard: null } });

    assert.deepEqual(turnBetween(before, toTheMover).drawnCard, card("diamonds-4"));
    assert.equal(turnBetween(before, toEverybodyElse).drawnCard, null);
  });

  it("has nothing to show when neither fact has changed", () => {
    // A Yaniv call: the position moves, and neither the last move nor the last slapdown
    // does (ADR-0007, ADR-0008). The facts are equal by value and not by identity — every
    // broadcast is serialized afresh — so a client that compared references would animate
    // the same turn twice.
    const stood = {
      lastDiscard: cards("hearts-5"),
      lastMove: { playerId: "p2", drawSource: "deck", drawnCard: null } as const,
      lastSlapdown: { playerId: "p1", card: card("diamonds-5") },
    };

    assert.equal(flightFrom(position(stood), position({ ...stood, drawPileCount: 29 })), null);
  });

  it("has nothing to show for the first position of all", () => {
    // A seat claimed back mid-round lands here too: the position arrives with whatever
    // move happened to be last, and nobody watching wants a turn taken while they were
    // away replayed at them.
    const landing = position({
      lastDiscard: cards("hearts-5"),
      lastMove: { playerId: "p2", drawSource: "deck", drawnCard: null },
    });

    assert.equal(flightFrom(null, landing), null);
  });

  it("has nothing to show across a deal", () => {
    // Cards leaving one round's hands for the next round's deal are not a move: nobody
    // discarded them and nobody drew them.
    const before = position({
      roundNumber: 1,
      lastDiscard: cards("hearts-5"),
      lastMove: { playerId: "p2", drawSource: "deck", drawnCard: null },
    });
    const after = position({
      roundNumber: 2,
      lastDiscard: cards("clubs-7"),
      lastMove: { playerId: "p1", drawSource: "deck", drawnCard: card("spades-9") },
    });

    assert.equal(flightFrom(before, after), null);
  });

  it("has nothing to show unless both positions are a round being played", () => {
    // Neither a scored round nor a lobby has a hand to fly a card out of, whatever the
    // last move standing behind it says. The round the Yaniv call ended is the case in
    // practice, and it arrives carrying the turn before it.
    const played = position({
      lastMove: { playerId: "p2", drawSource: "deck", drawnCard: null },
    });
    const scored = position({
      phase: "roundEnd",
      lastMove: { playerId: "p1", drawSource: "discard", drawnCard: card("clubs-7") },
    });

    assert.equal(flightFrom(played, scored), null, "the round being scored");
    assert.equal(flightFrom(scored, played), null, "and whatever follows a scored one");
  });

  describe("a slapdown", () => {
    /** The turn that opened the window, standing where it was throughout (ADR-0007). */
    const move = { playerId: "p2", drawSource: "deck", drawnCard: null } as const;
    const slapped = { playerId: "p1", card: card("diamonds-5") };

    it("describes the card put down out of turn, and whose it was", () => {
      // Structurally not a turn: one card leaves a hand and nothing comes back, so there is
      // no draw to name and no set — which is why the two are told apart by a tag rather
      // than by which fields happen to be filled in.
      const before = position({ lastDiscard: cards("hearts-5"), lastMove: move });
      const after = position({
        lastDiscard: cards("hearts-5", "diamonds-5"),
        lastMove: move,
        lastSlapdown: slapped,
      });

      assert.deepEqual(flightFrom(before, after), {
        kind: "slapdown",
        playerId: "p1",
        card: card("diamonds-5"),
      });
    });

    it("is watched for changes the way the last move is", () => {
      // The fact is left standing until the next slapdown overwrites it, so the turn that
      // closes the window arrives with it still there — and is the turn flying, not the slap
      // a second time. At most one of the two facts changes per broadcast.
      const before = position({ lastMove: move, lastSlapdown: slapped });
      const after = position({
        lastDiscard: cards("clubs-9"),
        lastMove: { playerId: "p1", drawSource: "discard", drawnCard: card("hearts-5") },
        lastSlapdown: slapped,
      });

      assert.equal(turnBetween(before, after).kind, "turn", "the fact that changed is the turn");
    });

    it("is not flown again for a slap already shown", () => {
      const before = position({ lastMove: move, lastSlapdown: slapped });
      const after = position({ lastMove: move, lastSlapdown: { ...slapped } });

      assert.equal(flightFrom(before, after), null);
    });

    it("has nothing to show across a deal", () => {
      // The same rule the last move is held to: a fact from the round before is not a card
      // anybody at this table just watched leave a hand.
      const before = position({ roundNumber: 1, lastMove: move, lastSlapdown: null });
      const after = position({ roundNumber: 2, lastMove: null, lastSlapdown: slapped });

      assert.equal(flightFrom(before, after), null);
    });

    it("has nothing to show unless both positions are a round being played", () => {
      const played = position({ lastMove: move, lastSlapdown: null });
      const scored = position({ phase: "roundEnd", lastMove: move, lastSlapdown: slapped });

      assert.equal(flightFrom(played, scored), null, "the round being scored");
      assert.equal(flightFrom(scored, played), null, "and whatever follows a scored one");
    });

    it("has nothing to show for the first position of all", () => {
      assert.equal(flightFrom(null, position({ lastMove: move, lastSlapdown: slapped })), null);
    });
  });
});
