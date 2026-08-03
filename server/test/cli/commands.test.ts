/**
 * Parsing what a developer types into an intent the harness can act on.
 *
 * Pure, and view-aware: hand positions and pickup numbers only mean anything against
 * the view currently on screen, so the view is an input rather than something the
 * session resolves afterwards. Bad input is a returned value, never a throw — the
 * harness has to survive a typo.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callYaniv } from "../../src/game.ts";
import { serializeStateForPlayer } from "../../src/serialize.ts";
import { parseCommand } from "../../scripts/cli/commands.ts";
import { makeState, unwrap } from "../helpers.ts";

/** A view whose owner holds Jk 5♣ 7♦, with 8♥ 9♥ face up to pick from. */
function midRoundView() {
  return serializeStateForPlayer(
    makeState({
      players: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Grace" },
      ],
      hands: { p1: ["clubs-5", "diamonds-7", "joker-1"], p2: ["hearts-2"] },
      lastDiscard: ["hearts-8", "hearts-9"],
      drawPile: ["spades-2"],
      currentTurnPlayerId: "p1",
    }),
    "p1",
  );
}

/** A view of an open lobby, seen by its host, with one other player seated. */
function lobbyView() {
  return serializeStateForPlayer(
    makeState({
      phase: "lobby",
      players: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Grace" },
      ],
    }),
    "p1",
  );
}

describe("parseCommand", () => {
  it("reads hand positions as a discard, drawing from the deck by default", () => {
    const command = parseCommand("2 3", midRoundView());

    assert.deepEqual(command, {
      kind: "turn",
      action: {
        discardCardIds: ["clubs-5", "diamonds-7"],
        draw: { source: "deck" },
      },
    });
  });

  it("takes a face-up card when the line ends with a table pick", () => {
    const command = parseCommand("2 3 t2", midRoundView());

    assert.deepEqual(command, {
      kind: "turn",
      action: {
        discardCardIds: ["clubs-5", "diamonds-7"],
        // t2 is the second pickup-eligible card: the far end of the last discard.
        draw: { source: "discard", cardId: "hearts-9" },
      },
    });
  });

  it("recognises yaniv and quit as whole-line commands", () => {
    assert.deepEqual(parseCommand("yaniv", midRoundView()), { kind: "yaniv" });
    assert.deepEqual(parseCommand("q", midRoundView()), { kind: "quit" });
  });

  it("explains itself rather than throwing on a line it cannot read", () => {
    const command = parseCommand("banana", midRoundView());

    assert.equal(command.kind, "invalid");
    assert.match(
      command.kind === "invalid" ? command.message : "",
      /number/,
      "an invalid command carries something worth printing",
    );
  });

  it("rejects a table pick that is not on offer", () => {
    // Only the two ends of the last discard can be taken, so there is no t3.
    const command = parseCommand("2 3 t3", midRoundView());

    assert.equal(command.kind, "invalid");
  });

  it("reads 'start' as the host's go-ahead, but only while the lobby is open", () => {
    assert.deepEqual(parseCommand("start", lobbyView()), { kind: "start" });
    // Mid-round the word means nothing: there is no lobby left to start.
    assert.equal(parseCommand("start", midRoundView()).kind, "invalid");
  });

  it("turns down anything else typed in the lobby, without mentioning cards", () => {
    const command = parseCommand("banana", lobbyView());

    assert.equal(command.kind, "invalid");
    const message = command.kind === "invalid" ? command.message : "";
    assert.match(message, /start/, "the lobby tells you the one thing you can do");
    assert.doesNotMatch(
      message,
      /number/,
      "nobody holds a hand yet, so hand positions are not the advice to give",
    );
  });

  it("still quits from the lobby, and ignores a stray enter there", () => {
    assert.deepEqual(parseCommand("q", lobbyView()), { kind: "quit" });
    assert.deepEqual(parseCommand("", lobbyView()), { kind: "noop" });
  });

  it("reads a bare enter as 'deal the next round', but only once one has ended", () => {
    const ended = unwrap(
      callYaniv(
        makeState({
          players: [
            { id: "p1", name: "Ada" },
            { id: "p2", name: "Grace" },
          ],
          hands: { p1: ["clubs-2", "clubs-3"], p2: ["hearts-K"] },
          lastDiscard: ["hearts-8"],
          drawPile: ["spades-2"],
          currentTurnPlayerId: "p1",
        }),
        "p1",
      ),
    );

    assert.deepEqual(parseCommand("", serializeStateForPlayer(ended, "p1")), {
      kind: "next",
    });
    // Mid-round the same keystroke is just an accident: do nothing, ask again.
    assert.deepEqual(parseCommand("", midRoundView()), { kind: "noop" });
  });
});
