import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callYaniv, startGame } from "../src/game.ts";
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

    const visible = new Set([
      ...state.round!.hands["p1"]!.map((c) => c.id),
      ...state.round!.lastDiscard.map((c) => c.id),
    ]);
    for (const card of [
      ...state.round!.hands["p2"]!,
      ...state.round!.drawPile,
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

describe("serializeStateForPlayer — lobby", () => {
  it("reports an empty table before the first deal", () => {
    const view = serializeStateForPlayer(makeState({ phase: "lobby" }), "p1");

    assert.equal(view.phase, "lobby");
    assert.deepEqual(view.you.hand, []);
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
});
