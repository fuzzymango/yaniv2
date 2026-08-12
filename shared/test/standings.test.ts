import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { standings } from "../src/standings.ts";
import type { PlayerGameView, PlayerRoundResultView } from "../src/views.ts";

/**
 * A finished match, described by what the standings actually read: who is still seated,
 * what everyone finished on, and the record of the round that ended it.
 *
 * The hands are empty because nothing here looks at them — a fixture that filled them in
 * would be claiming otherwise.
 */
function finishedMatch(options: {
  seated: { id: string; name: string; score: number }[];
  played?: { id: string; name: string; score: number }[];
  turnOrder?: string[];
}): PlayerGameView {
  const [you, ...opponents] = options.seated as [
    { id: string; name: string; score: number },
    ...{ id: string; name: string; score: number }[],
  ];
  const played = options.played ?? options.seated;

  const players: PlayerRoundResultView[] = played.map((p) => ({
    playerId: p.id,
    name: p.name,
    hand: [],
    handValue: 0,
    delta: 0,
    scoreAfter: p.score,
  }));

  return {
    roomCode: "ABCD",
    phase: "gameEnd",
    roundNumber: 4,
    hostId: you.id,
    you: { ...you, hand: [], slapdownEligible: false },
    opponents: opponents.map((p) => ({ ...p, handSize: 0 })),
    turnOrder: options.turnOrder ?? options.seated.map((p) => p.id),
    currentTurnPlayerId: null,
    drawPileCount: 0,
    lastDiscard: [],
    buriedCount: 0,
    roundResult: { roundNumber: 4, callerId: you.id, assaferId: null, winnerId: you.id, players },
    winnerIds: [you.id],
  };
}

describe("standings", () => {
  it("puts the lowest score first, because in Yaniv least is best", () => {
    const rows = standings(
      finishedMatch({
        seated: [
          { id: "p1", name: "Ada", score: 104 },
          { id: "p2", name: "Grace", score: 12 },
          { id: "p3", name: "Alan", score: 71 },
        ],
      }),
    );

    assert.deepEqual(
      rows.map((r) => r.name),
      ["Grace", "Alan", "Ada"],
    );
    assert.deepEqual(
      rows.map((r) => r.score),
      [12, 71, 104],
    );
  });

  it("breaks a tie by where the two were sitting, not by whose screen it is", () => {
    const level = [
      { id: "p1", name: "Ada", score: 40 },
      { id: "p2", name: "Grace", score: 40 },
      { id: "p3", name: "Alan", score: 40 },
    ];

    // The viewer is listed first in the view whoever they are, so a sort that fell back on
    // roster order would put a different player on top of each player's screen.
    const seenByAda = standings(finishedMatch({ seated: level }));
    const seenByGrace = standings(
      finishedMatch({
        seated: [level[1]!, level[0]!, level[2]!],
        turnOrder: ["p1", "p2", "p3"],
      }),
    );

    assert.deepEqual(
      seenByAda.map((r) => r.playerId),
      ["p1", "p2", "p3"],
    );
    assert.deepEqual(
      seenByGrace.map((r) => r.playerId),
      seenByAda.map((r) => r.playerId),
      "both screens list the same match the same way round",
    );
  });

  it("still lists a player who gave up their seat, named from the round they played", () => {
    const rows = standings(
      finishedMatch({
        seated: [{ id: "p1", name: "Ada", score: 104 }],
        played: [
          { id: "p1", name: "Ada", score: 104 },
          { id: "p2", name: "Grace", score: 12 },
        ],
        turnOrder: ["p1"],
      }),
    );

    assert.deepEqual(
      rows.map((r) => [r.name, r.score, r.departed]),
      [
        ["Grace", 12, true],
        ["Ada", 104, false],
      ],
      "leaving does not undo how the match finished, so a departed winner keeps the top row",
    );
  });

  it("sits a departed player after whoever stayed when they finished level", () => {
    const rows = standings(
      finishedMatch({
        seated: [{ id: "p1", name: "Ada", score: 40 }],
        played: [
          { id: "p1", name: "Ada", score: 40 },
          { id: "p2", name: "Grace", score: 40 },
        ],
        turnOrder: ["p1"],
      }),
    );

    // There is no seat left to compare them by, so the one still at the table goes first.
    assert.deepEqual(
      rows.map((r) => r.playerId),
      ["p1", "p2"],
    );
  });

  it("is just the roster when nobody has left", () => {
    const rows = standings(
      finishedMatch({
        seated: [
          { id: "p1", name: "Ada", score: 104 },
          { id: "p2", name: "Grace", score: 12 },
        ],
      }),
    );

    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => !r.departed));
  });

  it("stands up without a round behind it, which the wire type allows", () => {
    const view = finishedMatch({
      seated: [
        { id: "p1", name: "Ada", score: 104 },
        { id: "p2", name: "Grace", score: 12 },
      ],
    });

    const rows = standings({ ...view, roundResult: null });

    // Nobody can be shown as departed without the record that names them, but everybody
    // still seated is still placed.
    assert.deepEqual(
      rows.map((r) => r.name),
      ["Grace", "Ada"],
    );
  });
});
