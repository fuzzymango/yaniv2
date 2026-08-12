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
import { parseCommand, parseMainMenuCommand } from "../../scripts/cli/commands.ts";
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

/** A view of a match Ada has just won, seen by Ada — who is also the host. */
function gameEndView() {
  const ended = unwrap(
    callYaniv(
      makeState({
        players: [
          { id: "p1", name: "Ada" },
          // One bad round from busting past 100, which is what ends the match.
          { id: "p2", name: "Grace", score: 95 },
        ],
        hands: { p1: ["clubs-2", "clubs-3"], p2: ["hearts-K", "spades-Q"] },
        lastDiscard: ["hearts-8"],
        drawPile: ["spades-2"],
        currentTurnPlayerId: "p1",
      }),
      "p1",
    ),
  );
  return serializeStateForPlayer(ended, "p1");
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

  /**
   * Read against the view like every other mid-round line, but *not* checked against
   * `slapdownEligible`: whether a window is open is the server's to answer, exactly as
   * whose turn it is already is. A slap with nothing to slap comes back
   * `SLAPDOWN_NOT_AVAILABLE`, which is how a developer finds out.
   */
  it("recognises slap as a whole-line command, window open or not", () => {
    assert.deepEqual(parseCommand("slap", midRoundView()), { kind: "slap" });
    assert.deepEqual(parseCommand("SLAP", midRoundView()), { kind: "slap" });
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

  it("reads 'menu' as leaving the lobby, distinct from quitting the harness", () => {
    assert.deepEqual(parseCommand("menu", lobbyView()), { kind: "menu" });
    assert.deepEqual(parseCommand("q", lobbyView()), { kind: "quit" });
    // Mid-round there is no leaving without dropping the connection, so the word is
    // just another unreadable line.
    assert.equal(parseCommand("menu", midRoundView()).kind, "invalid");
  });

  it("still quits from the lobby, and ignores a stray enter there", () => {
    assert.deepEqual(parseCommand("q", lobbyView()), { kind: "quit" });
    assert.deepEqual(parseCommand("", lobbyView()), { kind: "noop" });
  });

  it("reads 'again' and 'menu' as the two ways on from a finished match", () => {
    assert.deepEqual(parseCommand("again", gameEndView()), { kind: "again" });
    assert.deepEqual(parseCommand("menu", gameEndView()), { kind: "menu" });
    // Mid-round neither means anything: there is no match to replay or leave yet.
    assert.equal(parseCommand("again", midRoundView()).kind, "invalid");
  });

  it("turns down anything else typed at a finished match, without mentioning cards", () => {
    const command = parseCommand("banana", gameEndView());

    assert.equal(command.kind, "invalid");
    const message = command.kind === "invalid" ? command.message : "";
    assert.match(message, /again/, "the advice names the way on");
    assert.match(message, /menu/, "and the way out");
    assert.doesNotMatch(
      message,
      /number/,
      "the hands on screen are a result, not a hand to play from",
    );
  });

  it("still quits from a finished match, and ignores a stray enter there", () => {
    // Unlike `roundEnd`, there is no next round for an enter to deal.
    assert.deepEqual(parseCommand("q", gameEndView()), { kind: "quit" });
    assert.deepEqual(parseCommand("", gameEndView()), { kind: "noop" });
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

describe("parseMainMenuCommand", () => {
  it("reads 'create' as opening a new room", () => {
    assert.deepEqual(parseMainMenuCommand("create"), { kind: "create" });
  });

  it("reads 'join <code>' as joining that room, case-insensitively", () => {
    assert.deepEqual(parseMainMenuCommand("join WXYZ"), {
      kind: "join",
      roomCode: "WXYZ",
    });
    assert.deepEqual(parseMainMenuCommand("JOIN wxyz"), {
      kind: "join",
      roomCode: "wxyz",
    });
  });

  it("recognises q and quit as leaving the application", () => {
    assert.deepEqual(parseMainMenuCommand("q"), { kind: "quit" });
    assert.deepEqual(parseMainMenuCommand("quit"), { kind: "quit" });
  });

  it("treats a bare enter as nothing to do", () => {
    assert.deepEqual(parseMainMenuCommand(""), { kind: "noop" });
  });

  it("explains itself rather than crashing on a line it cannot read", () => {
    const command = parseMainMenuCommand("banana");

    assert.equal(command.kind, "invalid");
    assert.match(
      command.kind === "invalid" ? command.message : "",
      /create|join|quit/,
      "an invalid command points at what the menu actually accepts",
    );
  });

  it("rejects a bare 'join' with no code, rather than joining nothing", () => {
    assert.equal(parseMainMenuCommand("join").kind, "invalid");
    assert.equal(parseMainMenuCommand("join ").kind, "invalid");
  });
});
