import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callYaniv, removePlayer, startGame } from "../src/game.ts";
import { mulberry32 } from "../src/rng.ts";
import { serializeStateForPlayer } from "../src/serialize.ts";
import { ids, makeState, unwrap } from "./helpers.ts";

const scenario = () =>
  makeState({
    players: [
      { id: "p1", name: "Ada", score: 12 },
      { id: "p2", name: "Grace", score: 30 },
    ],
    hands: {
      p1: ["hearts-3", "hearts-4"],
      p2: ["spades-K", "spades-Q", "clubs-9"],
    },
    drawPile: ["diamonds-2", "diamonds-3"],
    lastDiscard: ["clubs-7"],
    buried: ["hearts-10"],
  });

describe("serializeStateForPlayer", () => {
  it("gives the viewer their own hand", () => {
    const view = serializeStateForPlayer(scenario(), "p1");
    assert.equal(view.you.id, "p1");
    assert.equal(view.you.name, "Ada");
    assert.equal(view.you.score, 12);
    assert.deepEqual(ids(view.you.hand), ["hearts-3", "hearts-4"]);
  });

  it("gives opponents a hand size and no hand field at all", () => {
    const view = serializeStateForPlayer(scenario(), "p1");
    assert.equal(view.opponents.length, 1);

    const opponent = view.opponents[0]!;
    assert.equal(opponent.id, "p2");
    assert.equal(opponent.handSize, 3);
    assert.ok(!("hand" in opponent), "opponent view must not carry a hand key");
  });

  it("delivers the viewer's hand in display order regardless of engine order", () => {
    const state = makeState({
      players: [{ id: "p1", name: "Ada" }, { id: "p2", name: "Grace" }],
      hands: {
        p1: ["spades-K", "hearts-5", "joker-1", "clubs-A", "diamonds-10"],
        p2: ["clubs-9"],
      },
      lastDiscard: ["clubs-7"],
    });
    const view = serializeStateForPlayer(state, "p1");

    assert.deepEqual(ids(view.you.hand), [
      "joker-1",
      "clubs-A",
      "hearts-5",
      "diamonds-10",
      "spades-K",
    ]);
  });

  it("sorts the view without disturbing the engine's own hand order", () => {
    const state = makeState({
      hands: { p1: ["spades-K", "clubs-A"], p2: ["clubs-9"] },
      lastDiscard: ["clubs-7"],
    });
    serializeStateForPlayer(state, "p1");
    assert.equal(state.phase, "playing");
    assert.deepEqual(ids(state.round.hands["p1"]!), ["spades-K", "clubs-A"]);
  });

  it("reduces the draw pile to a count", () => {
    const view = serializeStateForPlayer(scenario(), "p1");
    assert.equal(view.drawPileCount, 2);
    assert.equal(view.buriedCount, 1);
  });

  it("sends the face-up discard in full", () => {
    const view = serializeStateForPlayer(scenario(), "p1");
    assert.deepEqual(ids(view.lastDiscard), ["clubs-7"]);
  });

  it("never leaks an opponent's cards through the wire format", () => {
    const wire = JSON.stringify(serializeStateForPlayer(scenario(), "p1"));
    for (const cardId of ["spades-K", "spades-Q", "clubs-9"]) {
      assert.ok(!wire.includes(cardId), `serialized view leaked ${cardId}`);
    }
  });

  it("never leaks the draw pile contents or order", () => {
    const wire = JSON.stringify(serializeStateForPlayer(scenario(), "p1"));
    for (const cardId of ["diamonds-2", "diamonds-3"]) {
      assert.ok(!wire.includes(cardId), `serialized view leaked ${cardId}`);
    }
  });

  it("leaks nothing from a freshly dealt 54-card round", () => {
    const state = unwrap(
      startGame(
        makeState({ phase: "lobby", roundNumber: 0 }),
        "p1",
        mulberry32(99),
      ),
    );
    const wire = JSON.stringify(serializeStateForPlayer(state, "p1"));

    assert.equal(state.phase, "playing");
    const visible = new Set([
      ...state.round.hands["p1"]!.map((c) => c.id),
      ...state.round.lastDiscard.map((c) => c.id),
    ]);
    for (const card of [
      ...state.round.hands["p2"]!,
      ...state.round.drawPile,
    ]) {
      if (visible.has(card.id)) continue;
      assert.ok(!wire.includes(card.id), `serialized view leaked ${card.id}`);
    }
  });

  it("shows the current turn only while a round is running", () => {
    const view = serializeStateForPlayer(scenario(), "p1");
    assert.equal(view.currentTurnPlayerId, "p1");
    assert.equal(view.roundResult, null);
    assert.equal(view.winnerIds, null);
  });

  it("throws for a player who is not in the game", () => {
    assert.throws(
      () => serializeStateForPlayer(scenario(), "ghost"),
      /unknown player ghost/,
    );
  });
});

/**
 * Slapdown eligibility is private information — it says the holder just drew a card of a
 * rank they had already discarded, which nothing else on the wire reveals. So it is a
 * field of `SelfView` alone, and the serializer is where that boundary is kept.
 */
describe("serializeStateForPlayer — slapdown eligibility", () => {
  const windowOpen = () =>
    makeState({
      players: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Grace" },
      ],
      hands: { p1: ["hearts-7", "hearts-3"], p2: ["spades-K"] },
      lastDiscard: ["clubs-7"],
      currentTurnPlayerId: "p2",
      slapdown: { playerId: "p1", cardId: "hearts-7" },
    });

  it("tells the player holding the window that they may slap down", () => {
    assert.equal(serializeStateForPlayer(windowOpen(), "p1").you.slapdownEligible, true);
  });

  it("tells nobody else, in any shape", () => {
    const view = serializeStateForPlayer(windowOpen(), "p2");

    assert.equal(view.you.slapdownEligible, false);
    for (const opponent of view.opponents) {
      assert.ok(
        !("slapdownEligible" in opponent),
        "an opponent must not carry an eligibility flag at all",
      );
    }
    assert.ok(
      !JSON.stringify(view).includes('"slapdownEligible":true'),
      "an open window leaked into someone else's view",
    );
  });

  it("reports no eligibility with no window open", () => {
    assert.equal(serializeStateForPlayer(scenario(), "p1").you.slapdownEligible, false);
  });
});

describe("serializeStateForPlayer — lobby", () => {
  it("reports an empty table before the first deal", () => {
    const view = serializeStateForPlayer(makeState({ phase: "lobby" }), "p1");

    assert.equal(view.phase, "lobby");
    assert.deepEqual(view.you.hand, []);
    assert.equal(view.you.slapdownEligible, false, "no round, nothing to slap down");
    assert.equal(view.opponents[0]!.handSize, 0);
    assert.equal(view.currentTurnPlayerId, null);
    assert.equal(view.drawPileCount, 0);
    assert.deepEqual(view.lastDiscard, []);
    assert.deepEqual(view.turnOrder, ["p1", "p2"]);
  });
});

describe("serializeStateForPlayer — round end", () => {
  const finished = () =>
    unwrap(
      callYaniv(
        makeState({
          players: [
            { id: "p1", name: "Ada" },
            { id: "p2", name: "Grace" },
          ],
          hands: {
            p1: ["hearts-A", "hearts-2"],
            p2: ["spades-K", "spades-Q"],
          },
        }),
        "p1",
      ),
    );

  it("reveals every hand once the round is over", () => {
    const view = serializeStateForPlayer(finished(), "p2");

    assert.equal(view.phase, "roundEnd");
    assert.ok(view.roundResult);
    assert.equal(view.roundResult.callerId, "p1");
    assert.equal(view.roundResult.assaferId, null);
    assert.equal(view.roundResult.winnerId, "p1");

    const caller = view.roundResult.players.find((p) => p.playerId === "p1")!;
    assert.equal(caller.name, "Ada");
    assert.deepEqual(ids(caller.hand), ["hearts-A", "hearts-2"]);
    assert.equal(caller.handValue, 3);
    assert.equal(caller.delta, 0);
  });

  it("stops highlighting a current turn", () => {
    assert.equal(serializeStateForPlayer(finished(), "p1").currentTurnPlayerId, null);
  });

  /**
   * A finished round is a record of who played it, and a player may give their seat up
   * once a match ends. Reading the name off the current roster would leave that record
   * naming nobody — the one thing a client cannot recover, since the roster is all it
   * ever sees.
   */
  it("still names a player who has left, in the round they played", () => {
    // Leaving is only allowed once the match is over, so the fixture has to bust
    // Grace past the score limit first.
    const ended = unwrap(
      callYaniv(
        makeState({
          players: [
            { id: "p1", name: "Ada" },
            { id: "p2", name: "Grace", score: 95 },
          ],
          hands: { p1: ["hearts-A", "hearts-2"], p2: ["spades-K", "spades-Q"] },
        }),
        "p1",
      ),
    );
    const view = serializeStateForPlayer(unwrap(removePlayer(ended, "p2")), "p1");

    assert.ok(view.roundResult);
    assert.ok(
      !view.opponents.some((o) => o.id === "p2"),
      "the fixture should have freed Grace's seat",
    );
    const grace = view.roundResult.players.find((p) => p.playerId === "p2")!;
    assert.equal(grace.name, "Grace");
    assert.equal(grace.scoreAfter, 115, "and what the round cost her");
  });
});
