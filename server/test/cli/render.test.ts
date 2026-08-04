/**
 * Rendering for the socket CLI harness: `PlayerGameView` in, a printable frame out.
 *
 * These assert on *content* — the cards, names and numbers a developer reads off the
 * screen — never on layout. Padding and colour are presentation the harness is free to
 * change; a test that pinned the exact spacing would break on every cosmetic tweak
 * without a single behaviour having changed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callYaniv, removePlayer } from "../../src/game.ts";
import { serializeStateForPlayer } from "../../src/serialize.ts";
import { renderMainMenu, renderView } from "../../scripts/cli/render.ts";
import { makeState, unwrap } from "../helpers.ts";

/** Colour is presentation; assertions read the text underneath it. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** An open lobby with two humans and a bot seated, as seen by `viewerId`. */
function lobbyView(viewerId: string) {
  return serializeStateForPlayer(
    makeState({
      phase: "lobby",
      players: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Grace" },
        { id: "p3", name: "Alan (bot)", isBot: true },
      ],
    }),
    viewerId,
  );
}

/**
 * A round Ada ends by calling Yaniv on 5, as seen by `viewerId`. Grace's hand decides
 * whether the call stands: give her more than 5 and it does, 5 or less and she Assafs.
 */
function roundEndView(viewerId: string, graceHand: string[]) {
  const ended = unwrap(
    callYaniv(
      makeState({
        players: [
          { id: "p1", name: "Ada" },
          { id: "p2", name: "Grace" },
        ],
        hands: { p1: ["clubs-2", "clubs-3"], p2: graceHand },
        lastDiscard: ["hearts-8"],
        drawPile: ["spades-2"],
        currentTurnPlayerId: "p1",
      }),
      "p1",
    ),
  );
  return serializeStateForPlayer(ended, viewerId);
}

describe("renderView", () => {
  it("shows the lobby's code and everyone seated in it, host marked", () => {
    const frame = plain(renderView(lobbyView("p2")));

    // The code is what the host reads aloud for anyone else to type in.
    assert.match(frame, /TEST/);
    for (const name of ["Ada", "Grace", "Alan"]) {
      assert.match(frame, new RegExp(name), `${name} is seated and should be listed`);
    }
    assert.match(frame, /Ada.*host/i, "the host is distinguishable from the rest");
  });

  it("marks only the viewer's own lobby seat with (you)", () => {
    const frame = plain(renderView(lobbyView("p2")));

    assert.match(frame, /Grace \(you\)/, "the viewer's own seat is theirs to find");
    assert.doesNotMatch(frame, /Ada \(you\)/, "another human's seat is not the viewer's");
    assert.match(frame, /Alan \(bot\)/, "a bot is still marked as one");
    assert.doesNotMatch(frame, /Alan \(bot\) \(you\)/, "and a bot is never the viewer");
  });

  it("marks the viewer's own seat (you) (host) when they are both", () => {
    assert.match(plain(renderView(lobbyView("p1"))), /Ada \(you\) \(host\)/);
  });

  it("tells the host to start, and everyone else that they are waiting", () => {
    assert.match(plain(renderView(lobbyView("p1"))), /type start/i);

    const guest = plain(renderView(lobbyView("p2")));
    assert.match(guest, /waiting/i);
    assert.doesNotMatch(
      guest,
      /type start/i,
      "only the host can start, so only the host is told to",
    );
  });

  it("offers the way out of the lobby to everyone sitting in it", () => {
    // Leaving is not the host's privilege the way starting is, so both screens say so.
    for (const viewer of ["p1", "p2"]) {
      assert.match(
        plain(renderView(lobbyView(viewer))),
        /menu/i,
        `${viewer} should be told they can leave`,
      );
    }
  });

  it("numbers the viewer's own hand so it can be selected by position", () => {
    const view = serializeStateForPlayer(
      makeState({
        players: [
          { id: "p1", name: "Ada" },
          { id: "p2", name: "Grace" },
        ],
        hands: { p1: ["clubs-5", "diamonds-7", "joker-1"], p2: ["hearts-2"] },
        lastDiscard: ["hearts-8"],
        currentTurnPlayerId: "p1",
      }),
      "p1",
    );

    const frame = plain(renderView(view));

    // Display order is the serializer's: joker (0) first, then 5, then 7.
    assert.match(frame, /1:Jk/);
    assert.match(frame, /2:5♣/);
    assert.match(frame, /3:7♦/);
  });

  it("shows each opponent as a card count and score, plus the table and deck", () => {
    const view = serializeStateForPlayer(
      makeState({
        players: [
          { id: "p1", name: "Ada" },
          { id: "p2", name: "Grace", score: 34 },
        ],
        hands: {
          p1: ["clubs-5"],
          p2: ["hearts-2", "hearts-3", "hearts-4"],
        },
        lastDiscard: ["hearts-8", "hearts-9"],
        drawPile: ["spades-2", "spades-3"],
        currentTurnPlayerId: "p1",
      }),
      "p1",
    );

    const frame = plain(renderView(view));

    assert.match(frame, /Grace.*3 cards.*34/);
    assert.match(frame, /8♥ 9♥/, "the face-up discard is the pickup menu");
    assert.match(frame, /deck 2/);
  });

  it("reveals every hand and the scoring when a round ends", () => {
    const frame = plain(renderView(roundEndView("p1", ["hearts-K", "spades-Q"])));

    assert.match(frame, /calls YANIV/);
    // Grace's hand is face up now — the rules require it, so the harness shows it.
    assert.match(frame, /Grace.*Q♠ K♥/);
    assert.match(frame, /Grace.*\+20/, "the loser takes their hand as points");
  });

  it("marks the viewer's own row and their own Yaniv call at round end", () => {
    const frame = plain(renderView(roundEndView("p1", ["hearts-K", "spades-Q"])));

    assert.match(frame, /Ada \(you\) calls YANIV/, "the viewer made the call");
    assert.match(frame, /Ada \(you\).*2♣ 3♣/, "and their revealed hand is their own");
    assert.doesNotMatch(frame, /Grace \(you\)/, "the loser is not the viewer");
  });

  it("leaves an opponent's Yaniv call unmarked", () => {
    const frame = plain(renderView(roundEndView("p2", ["hearts-K", "spades-Q"])));

    assert.match(frame, /Ada calls YANIV/);
    assert.doesNotMatch(frame, /Ada \(you\)/, "Ada is the opponent here");
    assert.match(frame, /Grace \(you\)/, "the viewer's own row is still marked");
  });

  it("marks the viewer's own Assaf", () => {
    const frame = plain(renderView(roundEndView("p2", ["diamonds-2", "diamonds-3"])));

    assert.match(frame, /ASSAF by Grace \(you\)/);
  });

  /** A match Ada wins outright, Grace having busted past 100. */
  function endedMatch() {
    // Grace is one bad round from busting past 100.
    return unwrap(
      callYaniv(
        makeState({
          players: [
            { id: "p1", name: "Ada" },
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
  }

  it("shows final standings and the winner when the match is over", () => {
    const view = serializeStateForPlayer(endedMatch(), "p1");
    assert.equal(view.phase, "gameEnd", "fixture should end the match");

    const frame = plain(renderView(view));

    assert.match(frame, /Match over/);
    assert.match(frame, /Ada \(you\)\s+0\s+← winner/, "the viewer's own placing");
    assert.match(frame, /Grace\s+115/);
    assert.doesNotMatch(frame, /Grace \(you\)/, "and nobody else's");
  });

  it("offers the host another match, and everyone else the wait", () => {
    const view = serializeStateForPlayer(endedMatch(), "p1");

    const host = plain(renderView(view));
    assert.match(host, /again/i, "the host is told they can deal another match");
    assert.match(host, /menu/i, "and that they can leave instead");

    const guest = plain(renderView(serializeStateForPlayer(endedMatch(), "p2")));
    assert.match(guest, /waiting/i, "only the host may replay, so everyone else waits");
    assert.match(guest, /menu/i, "but leaving is anyone's to do");
    assert.doesNotMatch(guest, /type again/i);
  });

  /**
   * A seat given up after the match ended. The player stays in the round result — the
   * record of who played the match — but is gone from the roster, so the standings have
   * to name them from that record and say they are no longer there.
   */
  it("keeps a departed player in the standings, named and marked as gone", () => {
    const left = unwrap(removePlayer(endedMatch(), "p2"));
    const frame = plain(renderView(serializeStateForPlayer(left, "p1")));

    assert.match(frame, /Grace \(left\)\s+115/, "who left, and what they finished on");
    assert.match(frame, /Ada \(you\)\s+0/, "alongside whoever stayed");
  });

  it("still names the winner of a match the winner has walked away from", () => {
    // Ada busts, so Grace wins on the lower score — and then leaves.
    const ended = unwrap(
      callYaniv(
        makeState({
          players: [
            { id: "p1", name: "Ada", score: 95 },
            { id: "p2", name: "Grace" },
          ],
          hands: { p1: ["clubs-2", "clubs-3"], p2: ["diamonds-2", "diamonds-3"] },
          lastDiscard: ["hearts-8"],
          drawPile: ["spades-2"],
          currentTurnPlayerId: "p1",
        }),
        "p1",
      ),
    );
    assert.equal(ended.phase, "gameEnd", "fixture should end the match");
    assert.deepEqual(ended.winnerIds, ["p2"], "fixture's winner is the one who leaves");

    const frame = plain(renderView(serializeStateForPlayer(unwrap(removePlayer(ended, "p2")), "p1")));

    assert.match(frame, /← winner/, "a finished match always has one");
  });
});

describe("renderMainMenu", () => {
  it("names the three options a player has before any room exists", () => {
    const frame = plain(renderMainMenu());

    assert.match(frame, /create/);
    assert.match(frame, /join/i);
    assert.match(frame, /quit|q\b/i);
  });
});
