import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { standings } from "../src/standings.ts";
import type { PlayerGameView } from "../src/views.ts";

/**
 * A finished match, described by what the standings actually read: the roster, what each
 * seat finished on, and the round each stopped playing in.
 *
 * The hands are empty and there is no round result behind it, because nothing here looks
 * at either — a fixture that filled them in would be claiming otherwise. That the roster
 * alone is enough *is* the change (issue #142): a departed player is a seat the roster
 * kept, not a name recovered from the last round.
 */
interface Seat {
  id: string;
  name: string;
  score: number;
  /** The round they went out in; still in the match when omitted. */
  outInRound?: number;
  /** They gave their seat up, and the roster kept it — the append-only case. */
  departed?: boolean;
}

function finishedMatch(seated: Seat[]): PlayerGameView {
  const [you, ...opponents] = seated as [Seat, ...Seat[]];
  // Everyone still there, connection being a fact about right now and the standings a
  // record of a match that is over: nothing here is read off it.
  const standing = (p: Seat) => ({
    outInRound: p.outInRound ?? null,
    departed: p.departed ?? false,
    connected: true,
    accountId: null,
  });

  return {
    roomCode: "ABCD",
    phase: "gameEnd",
    roundNumber: 4,
    hostId: you.id,
    settings: { handSize: 5, yanivThreshold: 7, maxScore: 100, botCount: 0 },
    you: { ...you, ...standing(you), spectating: false, hand: [], slapdownEligible: false },
    opponents: opponents.map((p) => ({
      ...p,
      ...standing(p),
      spectating: p.outInRound !== undefined && !p.departed,
      handSize: 0,
    })),
    // Every seat the match was played by, in the order they sat in — the roster, which the
    // standings are read off and which outlasts everyone going out of it.
    seating: seated.map((p) => p.id),
    // Only the players still in the match, which at `gameEnd` is the one who won it.
    turnOrder: seated.filter((p) => p.outInRound === undefined).map((p) => p.id),
    currentTurnPlayerId: null,
    drawPileCount: 0,
    lastDiscard: [],
    buriedCount: 0,
    lastMove: null,
    lastSlapdown: null,
    moveHistory: [],
    scorecard: [],
    roundResult: null,
    winnerIds: [you.id],
  };
}

describe("standings", () => {
  it("puts the survivor first, whatever they are holding", () => {
    const rows = standings(
      finishedMatch([
        { id: "p1", name: "Ada", score: 104, outInRound: 3 },
        { id: "p2", name: "Grace", score: 88 },
        { id: "p3", name: "Alan", score: 101, outInRound: 4 },
      ]),
    );

    // Grace is not the lowest score on the board — she is the one still in the match, and
    // the match is won by outlasting everybody (docs/rules.md §7).
    assert.deepEqual(
      rows.map((r) => r.name),
      ["Grace", "Alan", "Ada"],
    );
  });

  it("ranks the players who went out by how long they lasted", () => {
    const rows = standings(
      finishedMatch([
        { id: "p1", name: "Ada", score: 101, outInRound: 2 },
        { id: "p2", name: "Grace", score: 40 },
        { id: "p3", name: "Alan", score: 120, outInRound: 5 },
        { id: "p4", name: "Edsger", score: 110, outInRound: 3 },
      ]),
    );

    // Alan finished on the worst total of the three and still places above them: he was
    // there for two rounds neither of them saw.
    assert.deepEqual(
      rows.map((r) => r.name),
      ["Grace", "Alan", "Edsger", "Ada"],
    );
  });

  it("separates two players out in the same round by their final scores", () => {
    const rows = standings(
      finishedMatch([
        { id: "p1", name: "Ada", score: 130, outInRound: 3 },
        { id: "p2", name: "Grace", score: 40 },
        { id: "p3", name: "Alan", score: 105, outInRound: 3 },
      ]),
    );

    assert.deepEqual(
      rows.map((r) => [r.name, r.score]),
      [
        ["Grace", 40],
        ["Alan", 105],
        ["Ada", 130],
      ],
      "level on rounds, so least is best again",
    );
  });

  it("breaks a dead-level tie the same way on every screen, not by whose it is", () => {
    const level = [
      { id: "p1", name: "Ada", score: 105, outInRound: 3 },
      { id: "p2", name: "Grace", score: 40 },
      { id: "p3", name: "Alan", score: 105, outInRound: 3 },
    ];

    // A view hoists its own viewer to the front of the roster, so a tie broken by roster
    // position would put a different player on top of each player's screen.
    const seenByAda = standings(finishedMatch(level));
    const seenByAlan = standings(finishedMatch([level[2]!, level[0]!, level[1]!]));

    assert.deepEqual(
      seenByAda.map((r) => r.playerId),
      ["p2", "p1", "p3"],
      "nothing about the match separates Ada and Alan, so the order is at least a decided one",
    );
    assert.deepEqual(
      seenByAlan.map((r) => r.playerId),
      seenByAda.map((r) => r.playerId),
      "both screens list the same match the same way round",
    );
  });

  it("orders two players still in the match, which the rules do not reach", () => {
    // Unreachable at `gameEnd` — the match ends at one survivor — and a comparator that
    // answered `NaN` here would sort a lobby's roster by nothing at all.
    const rows = standings(
      finishedMatch([
        { id: "p1", name: "Ada", score: 40 },
        { id: "p2", name: "Grace", score: 12 },
        { id: "p3", name: "Alan", score: 71, outInRound: 2 },
      ]),
    );

    assert.deepEqual(
      rows.map((r) => r.name),
      ["Grace", "Ada", "Alan"],
    );
  });

  it("lists a player who gave up their seat, off the seat the roster kept", () => {
    const rows = standings(
      finishedMatch([
        { id: "p1", name: "Ada", score: 104, outInRound: 4 },
        { id: "p2", name: "Grace", score: 12, outInRound: 2, departed: true },
        { id: "p3", name: "Alan", score: 71 },
      ]),
    );

    assert.deepEqual(
      rows.map((r) => [r.name, r.score, r.departed]),
      [
        ["Alan", 71, false],
        ["Ada", 104, false],
        ["Grace", 12, true],
      ],
      "leaving in round 2 is leaving in round 2 — a low total does not buy back the rounds",
    );
  });

  it("is just the roster in match order when nobody has left", () => {
    const rows = standings(
      finishedMatch([
        { id: "p1", name: "Ada", score: 104, outInRound: 2 },
        { id: "p2", name: "Grace", score: 12 },
      ]),
    );

    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => !r.departed));
    assert.deepEqual(
      rows.map((r) => r.name),
      ["Grace", "Ada"],
    );
  });

  it("stands up on a match nobody has gone out of, which the lobby is", () => {
    const rows = standings(
      finishedMatch([
        { id: "p1", name: "Ada", score: 104 },
        { id: "p2", name: "Grace", score: 12 },
      ]),
    );

    // Every row is a survivor, so the sort is decided by score and then by the roster.
    assert.deepEqual(
      rows.map((r) => r.name),
      ["Grace", "Ada"],
    );
  });
});
