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
import { callYaniv } from "../../src/game.ts";
import { serializeStateForPlayer } from "../../src/serialize.ts";
import { renderView } from "../../scripts/cli/render.ts";
import { makeState, unwrap } from "../helpers.ts";

/** Colour is presentation; assertions read the text underneath it. */
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderView", () => {
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
    const ended = unwrap(
      callYaniv(
        makeState({
          players: [
            { id: "p1", name: "Ada" },
            { id: "p2", name: "Grace" },
          ],
          hands: { p1: ["clubs-2", "clubs-3"], p2: ["hearts-K", "spades-Q"] },
          lastDiscard: ["hearts-8"],
          drawPile: ["spades-2"],
          currentTurnPlayerId: "p1",
        }),
        "p1",
      ),
    );

    const frame = plain(renderView(serializeStateForPlayer(ended, "p1")));

    assert.match(frame, /Ada calls YANIV/);
    // Grace's hand is face up now — the rules require it, so the harness shows it.
    assert.match(frame, /Grace.*Q♠ K♥/);
    assert.match(frame, /Grace.*\+20/, "the loser takes their hand as points");
  });

  it("shows final standings and the winner when the match is over", () => {
    // Grace is one bad round from busting past 100.
    const ended = unwrap(
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
    const view = serializeStateForPlayer(ended, "p1");
    assert.equal(view.phase, "gameEnd", "fixture should end the match");

    const frame = plain(renderView(view));

    assert.match(frame, /Match over/);
    assert.match(frame, /Ada\s+0\s+← winner/);
    assert.match(frame, /Grace\s+115/);
  });
});
