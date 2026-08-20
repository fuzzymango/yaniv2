import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DrawSource } from "@yaniv/shared";
import { callYaniv, removePlayer, startGame } from "../src/game.ts";
import { mulberry32 } from "../src/rng.ts";
import { serializeStateForPlayer } from "../src/serialize.ts";
import type { GameState } from "../src/state.ts";
import { RESUME_TOKEN_MARK, ids, makeState, unwrap } from "./helpers.ts";

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

  /**
   * A resume token is a credential for a seat, so it is a secret of the same class as a
   * hidden hand — and a worse one to lose, since a leaked token is another player's
   * whole seat rather than a peek at their cards. Every phase is checked because a
   * `roundEnd` view opens up hands, and a serializer that reached for `state.players`
   * to do it would carry the tokens along.
   */
  it("never puts a resume token in any view, in any phase", () => {
    const lobby = makeState({ phase: "lobby" });
    const playing = scenario();
    const roundEnd = unwrap(
      callYaniv(
        makeState({
          hands: { p1: ["hearts-A", "hearts-2"], p2: ["spades-K", "spades-Q"] },
        }),
        "p1",
      ),
    );
    // The same call, against a hand that busts p2 past the score limit and ends the match.
    const gameEnd = unwrap(
      callYaniv(
        makeState({
          players: [{ id: "p1" }, { id: "p2", score: 95 }],
          hands: { p1: ["hearts-A"], p2: ["spades-K", "clubs-K"] },
        }),
        "p1",
      ),
    );
    assert.equal(gameEnd.phase, "gameEnd");

    for (const state of [lobby, playing, roundEnd, gameEnd]) {
      for (const viewer of state.players) {
        const wire = JSON.stringify(serializeStateForPlayer(state, viewer.id));
        assert.ok(
          !wire.includes(RESUME_TOKEN_MARK),
          `${state.phase} leaked a resume token to ${viewer.id}`,
        );
      }
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

/**
 * The move that just resolved, told to everyone — but its drawn card only where that card
 * is already public. A pickup came off the face-up pile a moment earlier, so it is news to
 * nobody; a deck draw is a card of the mover's hidden hand, and goes no further than them.
 * The same boundary `slapdownEligible` is kept on, one field along. Issue #70.
 */
describe("serializeStateForPlayer — the last move", () => {
  const moved = (drawSource: DrawSource) =>
    makeState({
      players: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Grace" },
        { id: "p3", name: "Alan" },
      ],
      hands: { p1: ["hearts-3", "spades-8"], p2: ["spades-K"], p3: ["clubs-9"] },
      lastDiscard: ["clubs-7"],
      currentTurnPlayerId: "p2",
      lastMove: { playerId: "p1", drawSource, drawnCardId: "spades-8" },
    });

  it("names the mover and the source for every viewer", () => {
    for (const viewer of ["p1", "p2", "p3"]) {
      const view = serializeStateForPlayer(moved("deck"), viewer);
      assert.equal(view.lastMove?.playerId, "p1");
      assert.equal(view.lastMove?.drawSource, "deck");
    }
  });

  it("shows a card taken off the discard pile to everyone", () => {
    for (const viewer of ["p1", "p2", "p3"]) {
      const view = serializeStateForPlayer(moved("discard"), viewer);
      assert.equal(view.lastMove?.drawnCard?.id, "spades-8", `hidden from ${viewer}`);
    }
  });

  it("shows a card taken off the deck to the mover alone", () => {
    const mover = serializeStateForPlayer(moved("deck"), "p1");
    assert.equal(mover.lastMove?.drawnCard?.id, "spades-8");

    for (const viewer of ["p2", "p3"]) {
      const view = serializeStateForPlayer(moved("deck"), viewer);
      assert.equal(view.lastMove?.drawnCard, null, `${viewer} was told what p1 drew`);
      assert.ok(
        !JSON.stringify(view).includes("spades-8"),
        `a deck draw leaked into ${viewer}'s payload`,
      );
    }
  });

  /**
   * A scored round reveals every hand, so the card is public by then anyway — the
   * redaction is kept all the same rather than made a question of phase, because "was
   * this viewer entitled to it" is one rule and a phase-dependent one is two.
   */
  it("stands after the round is scored, still redacted", () => {
    const scored = unwrap(
      callYaniv(
        makeState({
          hands: { p1: ["hearts-A", "hearts-2"], p2: ["spades-K"] },
          lastMove: { playerId: "p2", drawSource: "deck", drawnCardId: "spades-K" },
        }),
        "p1",
      ),
    );

    assert.equal(serializeStateForPlayer(scored, "p2").lastMove?.drawnCard?.id, "spades-K");
    assert.equal(serializeStateForPlayer(scored, "p1").lastMove?.drawnCard, null);
  });

  it("reports no move before one has been made", () => {
    assert.equal(serializeStateForPlayer(scenario(), "p1").lastMove, null);
    assert.equal(
      serializeStateForPlayer(makeState({ phase: "lobby" }), "p1").lastMove,
      null,
    );
  });
});

/**
 * The slapdown that just resolved, told to everyone in full. Nothing to redact, unlike
 * `lastMove.drawnCard`: a slapped card is face up on `lastDiscard` by the time this field
 * is written, so naming it says nothing the pile does not already. Issue #93, ADR-0008.
 */
describe("serializeStateForPlayer — the last slapdown", () => {
  const slapped = () =>
    makeState({
      players: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Grace" },
        { id: "p3", name: "Alan" },
      ],
      hands: { p1: ["hearts-3"], p2: ["spades-K"], p3: ["clubs-9"] },
      lastDiscard: ["hearts-7", "diamonds-7", "spades-7"],
      currentTurnPlayerId: "p2",
      lastSlapdown: { playerId: "p1", cardId: "spades-7" },
    });

  it("names the slapper and the card for every viewer alike", () => {
    for (const viewer of ["p1", "p2", "p3"]) {
      const view = serializeStateForPlayer(slapped(), viewer);
      assert.equal(view.lastSlapdown?.playerId, "p1", `hidden from ${viewer}`);
      assert.equal(view.lastSlapdown?.card.id, "spades-7", `hidden from ${viewer}`);
    }
  });

  /**
   * The reason it needs no redaction: the card it names is one of the cards on the
   * face-up pile every viewer is already sent in full.
   */
  it("names only a card already face up on the discard pile", () => {
    for (const viewer of ["p1", "p2", "p3"]) {
      const view = serializeStateForPlayer(slapped(), viewer);
      assert.ok(
        ids(view.lastDiscard).includes(view.lastSlapdown!.card.id),
        `${viewer} was told a card that is not on the pile`,
      );
    }
  });

  it("leaks nothing else of the slapper's hand", () => {
    const state = makeState({
      hands: { p1: ["hearts-3", "clubs-4"], p2: ["spades-K"] },
      lastDiscard: ["hearts-7", "spades-7"],
      currentTurnPlayerId: "p2",
      lastSlapdown: { playerId: "p1", cardId: "spades-7" },
    });
    const wire = JSON.stringify(serializeStateForPlayer(state, "p2"));

    for (const cardId of ["hearts-3", "clubs-4"]) {
      assert.ok(!wire.includes(cardId), `serialized view leaked ${cardId}`);
    }
  });

  it("says nothing about whose window is open — that stays `slapdownEligible`'s", () => {
    const view = serializeStateForPlayer(
      makeState({
        hands: { p1: ["spades-7"], p2: ["clubs-2"] },
        lastDiscard: ["hearts-7"],
        currentTurnPlayerId: "p2",
        slapdown: { playerId: "p1", cardId: "spades-7" },
      }),
      "p2",
    );

    assert.equal(view.lastSlapdown, null);
    assert.equal(view.you.slapdownEligible, false);
  });

  /** Ungated by phase, as `lastMove` is: the round it belongs to is the one being read. */
  it("stands once the round is scored", () => {
    const scored = unwrap(
      callYaniv(
        makeState({
          hands: { p1: ["hearts-A", "hearts-2"], p2: ["spades-K"] },
          lastDiscard: ["hearts-7", "spades-7"],
          lastSlapdown: { playerId: "p2", cardId: "spades-7" },
        }),
        "p1",
      ),
    );

    for (const viewer of ["p1", "p2"]) {
      const view = serializeStateForPlayer(scored, viewer);
      assert.equal(view.phase, "roundEnd");
      assert.equal(view.lastSlapdown?.playerId, "p2");
      assert.equal(view.lastSlapdown?.card.id, "spades-7");
    }
  });

  it("reports no slapdown before one has been made", () => {
    assert.equal(serializeStateForPlayer(scenario(), "p1").lastSlapdown, null);
    assert.equal(
      serializeStateForPlayer(makeState({ phase: "lobby" }), "p1").lastSlapdown,
      null,
    );
  });
});

/**
 * The round's whole log, redacted entry by entry on exactly the rule the last move is: a
 * deck draw is a card of the mover's hidden hand and goes no further than them, a pickup
 * was face up on the pile a moment earlier and is news to nobody. A history is where that
 * rule earns its keep — one redacted card is a card, a round of them unredacted is every
 * opponent's hand. Issue #90.
 */
describe("serializeStateForPlayer — the move history", () => {
  const logged = () =>
    makeState({
      players: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Grace" },
        { id: "p3", name: "Alan" },
      ],
      hands: { p1: ["hearts-3", "spades-8"], p2: ["spades-K"], p3: ["clubs-9"] },
      lastDiscard: ["clubs-7"],
      currentTurnPlayerId: "p2",
      moveHistory: [
        {
          kind: "turn",
          playerId: "p1",
          discardedIds: ["hearts-2"],
          drawSource: "deck",
          drawnCardId: "spades-8",
        },
        { kind: "slapdown", playerId: "p1", cardId: "spades-8" },
        {
          kind: "turn",
          playerId: "p2",
          discardedIds: ["diamonds-5"],
          drawSource: "discard",
          drawnCardId: "clubs-4",
        },
      ],
    });

  it("delivers every move in the order they were made", () => {
    for (const viewer of ["p1", "p2", "p3"]) {
      const view = serializeStateForPlayer(logged(), viewer);
      assert.deepEqual(
        view.moveHistory.map((entry) => [entry.kind, entry.playerId]),
        [
          ["turn", "p1"],
          ["slapdown", "p1"],
          ["turn", "p2"],
        ],
        `wrong history for ${viewer}`,
      );
    }
  });

  it("names the discarded set and the source of every turn, for every viewer", () => {
    for (const viewer of ["p1", "p2", "p3"]) {
      const view = serializeStateForPlayer(logged(), viewer);
      const first = view.moveHistory[0]!;
      assert.equal(first.kind, "turn");
      assert.deepEqual(ids(first.discarded), ["hearts-2"]);
      assert.equal(first.drawSource, "deck");
    }
  });

  it("passes a slapdown through whole, its card being face up already", () => {
    for (const viewer of ["p1", "p2", "p3"]) {
      const entry = serializeStateForPlayer(logged(), viewer).moveHistory[1]!;
      assert.equal(entry.kind, "slapdown");
      assert.equal(entry.card.id, "spades-8");
    }
  });

  it("shows a card taken off the discard pile to everyone", () => {
    for (const viewer of ["p1", "p2", "p3"]) {
      const entry = serializeStateForPlayer(logged(), viewer).moveHistory[2]!;
      assert.equal(entry.kind, "turn");
      assert.equal(entry.drawnCard?.id, "clubs-4", `hidden from ${viewer}`);
    }
  });

  it("shows a card taken off the deck to the mover alone", () => {
    const mine = serializeStateForPlayer(logged(), "p1").moveHistory[0]!;
    assert.equal(mine.kind, "turn");
    assert.equal(mine.drawnCard?.id, "spades-8");

    for (const viewer of ["p2", "p3"]) {
      const entry = serializeStateForPlayer(logged(), viewer).moveHistory[0]!;
      assert.equal(entry.kind, "turn");
      assert.equal(entry.drawnCard, null, `${viewer} was told what p1 drew`);
    }
  });

  /**
   * The leak test proper: a round of deck draws, none of them the viewer's, greped for
   * whole rather than read field by field — a history that redacted the drawn card and
   * carried it somewhere else would pass every assertion above and fail this one.
   */
  it("leaks no deck-drawn card of anyone else's into the payload", () => {
    const drawn = ["spades-8", "hearts-9", "diamonds-J"];
    const state = makeState({
      players: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Grace" },
        { id: "p3", name: "Alan" },
      ],
      hands: { p1: ["hearts-3"], p2: ["spades-8", "hearts-9"], p3: ["diamonds-J"] },
      lastDiscard: ["clubs-7"],
      moveHistory: [
        {
          kind: "turn",
          playerId: "p2",
          discardedIds: ["hearts-2"],
          drawSource: "deck",
          drawnCardId: "spades-8",
        },
        {
          kind: "turn",
          playerId: "p3",
          discardedIds: ["clubs-3"],
          drawSource: "deck",
          drawnCardId: "diamonds-J",
        },
        {
          kind: "turn",
          playerId: "p2",
          discardedIds: ["clubs-5"],
          drawSource: "deck",
          drawnCardId: "hearts-9",
        },
      ],
    });

    const wire = JSON.stringify(serializeStateForPlayer(state, "p1"));
    for (const cardId of drawn) {
      assert.ok(!wire.includes(cardId), `the history leaked ${cardId} to p1`);
    }
  });

  /**
   * The same leak test run against a deliberately broken serializer, to prove it can
   * fail: the convention `CLAUDE.md` records for this boundary, kept in the suite here
   * rather than as a one-off edit somebody has to remember to make.
   */
  it("would catch a serializer that stopped redacting", () => {
    // The break: the round's own entries, sent as they are. Every field of the real view
    // is otherwise identical, so the only thing this test can be answering is redaction.
    const leaky = (state: GameState, viewerId: string) => ({
      ...serializeStateForPlayer(state, viewerId),
      moveHistory: state.round?.moveHistory ?? [],
    });
    const state = makeState({
      hands: { p1: ["hearts-3"], p2: ["spades-8"] },
      lastDiscard: ["clubs-7"],
      moveHistory: [
        {
          kind: "turn",
          playerId: "p2",
          discardedIds: ["hearts-2"],
          drawSource: "deck",
          drawnCardId: "spades-8",
        },
      ],
    });

    assert.ok(
      JSON.stringify(leaky(state, "p1")).includes("spades-8"),
      "the leak test cannot fail, so it proves nothing",
    );
    assert.ok(
      !JSON.stringify(serializeStateForPlayer(state, "p1")).includes("spades-8"),
      "the real serializer leaked a deck draw",
    );
  });

  /** Delivered in full at `roundEnd` — the whole round is there to be read back. */
  it("stands once the round is scored, still redacted", () => {
    const scored = unwrap(
      callYaniv(
        makeState({
          hands: { p1: ["hearts-A", "hearts-2"], p2: ["spades-K"] },
          moveHistory: [
            {
              kind: "turn",
              playerId: "p2",
              discardedIds: ["hearts-5"],
              drawSource: "deck",
              drawnCardId: "spades-K",
            },
          ],
        }),
        "p1",
      ),
    );

    const mover = serializeStateForPlayer(scored, "p2").moveHistory[0]!;
    const other = serializeStateForPlayer(scored, "p1").moveHistory[0]!;
    assert.equal(mover.kind, "turn");
    assert.equal(other.kind, "turn");
    assert.equal(mover.drawnCard?.id, "spades-K");
    assert.equal(other.drawnCard, null);
  });

  it("is empty before a move has been made, and in the lobby", () => {
    assert.deepEqual(serializeStateForPlayer(scenario(), "p1").moveHistory, []);
    assert.deepEqual(
      serializeStateForPlayer(makeState({ phase: "lobby" }), "p1").moveHistory,
      [],
    );
  });
});

describe("serializeStateForPlayer — settings", () => {
  it("is present and carries the room's own values, in the lobby", () => {
    const view = serializeStateForPlayer(
      makeState({ phase: "lobby", settings: { handSize: 6, botCount: 2 } }),
      "p1",
    );
    assert.deepEqual(view.settings, {
      handSize: 6,
      yanivThreshold: 7,
      maxScore: 100,
      botCount: 2,
    });
  });

  it("is present mid-round", () => {
    const view = serializeStateForPlayer(
      scenario(),
      "p1",
    );
    assert.deepEqual(view.settings, {
      handSize: 5,
      yanivThreshold: 7,
      maxScore: 100,
      botCount: 0,
    });
  });

  it("is present at roundEnd and gameEnd", () => {
    const state = makeState({
      players: [
        { id: "p1", name: "Ada" },
        { id: "p2", name: "Grace" },
      ],
      hands: { p1: ["hearts-A"], p2: ["spades-K"] },
      settings: { yanivThreshold: 3 },
    });
    const view = serializeStateForPlayer(unwrap(callYaniv(state, "p1")), "p1");
    assert.equal(view.settings.yanivThreshold, 3);
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
    assert.equal(caller.milestoneReduction, 0);
  });

  it("passes a milestone reduction through to the wire unchanged", () => {
    const state = unwrap(
      callYaniv(
        makeState({
          players: [
            { id: "p1", name: "Ada", score: 0 },
            { id: "p2", name: "Grace", score: 42 },
          ],
          hands: { p1: ["hearts-A"], p2: ["clubs-8"] },
        }),
        "p1",
      ),
    );
    const view = serializeStateForPlayer(state, "p1");

    const grace = view.roundResult!.players.find((p) => p.playerId === "p2")!;
    assert.equal(grace.delta, 8);
    assert.equal(grace.milestoneReduction, 50);
    assert.equal(grace.scoreAfter, 0);
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
