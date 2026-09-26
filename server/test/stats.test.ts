import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  callYaniv,
  removePlayer,
  startNextRound,
  takeTurn,
  updateSettings,
} from "../src/game.ts";
import { mulberry32 } from "../src/rng.ts";
import type { GameState } from "../src/state.ts";
import { accountToCredit, statsEarned } from "../src/stats.ts";
import type { StateOptions } from "./helpers.ts";
import { makeState, unwrap } from "./helpers.ts";

describe("accountToCredit", () => {
  it("credits a signed-in player's call to their account", () => {
    const state = makeState({ players: [{ id: "ada", accountId: "acc-ada" }, { id: "p2" }] });

    assert.equal(accountToCredit(state, "ada"), "acc-ada");
  });

  it("credits a guest's call to nobody", () => {
    const state = makeState({ players: [{ id: "grace", accountId: null }, { id: "p2" }] });

    assert.equal(accountToCredit(state, "grace"), null);
  });

  it("credits a bot's call to nobody", () => {
    const state = makeState({ players: [{ id: "p1" }, { id: "bot", isBot: true }] });

    assert.equal(accountToCredit(state, "bot"), null);
  });

  /**
   * No construction seats a bot under an account, so this is the bot case above with the
   * other null taken away: it pins down that a bot is refused for *being* one, not because
   * its account happens to be empty — the two nulls docs/adr/0023 keeps apart.
   */
  it("credits a bot nobody even where its seat names an account", () => {
    const state = makeState({
      players: [{ id: "p1" }, { id: "bot", isBot: true, accountId: "acc-stray" }],
    });

    assert.equal(accountToCredit(state, "bot"), null);
  });

  it("credits nobody for a seat that is not at the table", () => {
    assert.equal(accountToCredit(makeState(), "stranger"), null);
  });
});

/**
 * The case matrix for `statsEarned` (docs/adr/0024), over positions driven through the
 * real transitions rather than written out by hand where the transition is the point: what
 * is under test is which facts a transition makes true, and a hand-built `after` would
 * only be testing the builder.
 */
describe("statsEarned", () => {
  /** Ada is signed in, Grace a guest and Bob a bot; Ada's turn, holding a legal call. */
  const table = (overrides: StateOptions = {}): GameState =>
    makeState({
      players: [
        { id: "ada", accountId: "acc-ada" },
        { id: "grace", accountId: null },
        { id: "bob", isBot: true },
      ],
      hands: {
        ada: ["hearts-A", "hearts-2"],
        grace: ["spades-K", "spades-Q"],
        bob: ["clubs-J", "clubs-10"],
      },
      drawPile: ["diamonds-4", "diamonds-5"],
      lastDiscard: ["clubs-7"],
      ...overrides,
    });

  it("credits a call that stood with one Yaniv call and nothing else", () => {
    const before = table();
    const after = unwrap(callYaniv(before, "ada"));
    assert.equal(after.lastRoundResult!.assaferId, null, "the call stood");

    assert.deepEqual(statsEarned(before, after), new Map([["acc-ada", { yanivCalls: 1 }]]));
  });

  it("credits a call that was Assafed with a Yaniv call all the same", () => {
    const before = table({
      hands: { ada: ["hearts-A", "hearts-2"], grace: ["spades-A"], bob: ["clubs-J"] },
    });
    const after = unwrap(callYaniv(before, "ada"));
    assert.equal(after.lastRoundResult!.assaferId, "grace", "the round is Assafed");

    assert.equal(statsEarned(before, after).get("acc-ada")?.yanivCalls, 1);
  });

  /**
   * Every hand is written out: `makeState` deals an unnamed hand no cards, worth 0, and a
   * hand worth 0 Assafs any call — which would make a bystander the subject of the test.
   */
  it("credits a bot's call to nobody", () => {
    const before = table({
      currentTurnPlayerId: "bob",
      hands: { ada: ["hearts-K"], grace: ["spades-K"], bob: ["clubs-A"] },
    });

    assert.deepEqual(statsEarned(before, unwrap(callYaniv(before, "bob"))), new Map());
  });

  it("credits a guest's call to nobody", () => {
    const before = table({
      currentTurnPlayerId: "grace",
      hands: { ada: ["hearts-K"], grace: ["spades-A"], bob: ["clubs-K"] },
    });

    assert.deepEqual(statsEarned(before, unwrap(callYaniv(before, "grace"))), new Map());
  });

  /**
   * Ada and Linus signed in, Grace a guest and Bob a bot, seated in that order; Ada's call
   * at 3 unless a test deals otherwise. Every hand is named, for the reason above.
   */
  const assafTable = (hands: Record<string, string[]>, caller = "ada"): GameState =>
    makeState({
      players: [
        { id: "ada", accountId: "acc-ada" },
        { id: "linus", accountId: "acc-linus" },
        { id: "grace", accountId: null },
        { id: "bob", isBot: true },
      ],
      hands: {
        ada: ["hearts-A", "hearts-2"],
        linus: ["spades-K"],
        grace: ["clubs-K"],
        bob: ["diamonds-K"],
        ...hands,
      },
      currentTurnPlayerId: caller,
    });

  /**
   * The call `caller` makes from `before`, asserting the round names `assaferId` as its
   * Assafer — so a fixture dealt wrong fails as a fixture, not as a stat.
   */
  const callAssafedBy = (before: GameState, caller: string, assaferId: string | null): GameState => {
    const after = unwrap(callYaniv(before, caller));
    assert.equal(after.lastRoundResult!.assaferId, assaferId, "the round's Assafer");
    return after;
  };

  it("credits an Assafed call's caller with a call Assafed in the same delta, and the Assafer an Assaf", () => {
    const before = assafTable({ linus: ["spades-A"] });

    assert.deepEqual(
      statsEarned(before, callAssafedBy(before, "ada", "linus")),
      new Map([
        ["acc-ada", { yanivCalls: 1, callsAssafed: 1 }],
        ["acc-linus", { assafs: 1 }],
      ]),
    );
  });

  /**
   * §6 names one Assafer, and the stat agrees with the red cell the table showed. Bob calls
   * at 3 and both Ada and Linus tie him; Ada sits first after the caller, so the tie is hers.
   */
  it("credits no Assaf to a player who tied the Assafer and lost the tie-break", () => {
    const before = assafTable(
      { bob: ["diamonds-A", "diamonds-2"], ada: ["hearts-3"], linus: ["spades-A", "spades-2"] },
      "bob",
    );

    assert.deepEqual(
      statsEarned(before, callAssafedBy(before, "bob", "ada")),
      new Map([["acc-ada", { assafs: 1 }]]),
    );
  });

  /** Ada is at or under Bob's call, first after him even, but Linus is lower. */
  it("credits no Assaf to a player at or under the call who was not the lowest", () => {
    const before = assafTable(
      { bob: ["diamonds-A", "diamonds-2"], ada: ["hearts-3"], linus: ["spades-A"] },
      "bob",
    );

    assert.deepEqual(
      statsEarned(before, callAssafedBy(before, "bob", "linus")),
      new Map([["acc-linus", { assafs: 1 }]]),
    );
  });

  it("credits a player who Assafs a bot's call with an Assaf, and the bot nothing", () => {
    const before = assafTable({ bob: ["diamonds-A", "diamonds-2"], ada: ["hearts-A"] }, "bob");

    assert.deepEqual(
      statsEarned(before, callAssafedBy(before, "bob", "ada")),
      new Map([["acc-ada", { assafs: 1 }]]),
    );
  });

  it("credits a player whose call a bot Assafs with a call Assafed, and the bot nothing", () => {
    const before = assafTable({ bob: ["diamonds-A"] });

    assert.deepEqual(
      statsEarned(before, callAssafedBy(before, "ada", "bob")),
      new Map([["acc-ada", { yanivCalls: 1, callsAssafed: 1 }]]),
    );
  });

  it("credits a guest who Assafs a call with nothing, and the caller all the same", () => {
    const before = assafTable({ grace: ["clubs-A"] });

    assert.deepEqual(
      statsEarned(before, callAssafedBy(before, "ada", "grace")),
      new Map([["acc-ada", { yanivCalls: 1, callsAssafed: 1 }]]),
    );
  });

  it("credits a guest whose call is Assafed with nothing, and the Assafer all the same", () => {
    const before = assafTable({ grace: ["clubs-A", "clubs-2"], ada: ["hearts-A"] }, "grace");

    assert.deepEqual(
      statsEarned(before, callAssafedBy(before, "grace", "ada")),
      new Map([["acc-ada", { assafs: 1 }]]),
    );
  });

  it("credits nobody where a bot Assafs a guest's call", () => {
    const before = assafTable({ grace: ["clubs-A", "clubs-2"], bob: ["diamonds-A"] }, "grace");

    assert.deepEqual(statsEarned(before, callAssafedBy(before, "grace", "bob")), new Map());
  });

  it("earns nothing for a plain turn", () => {
    const before = table();
    const after = unwrap(
      takeTurn(
        before,
        "ada",
        { discardCardIds: ["hearts-A"], draw: { source: "deck" } },
        mulberry32(1),
      ),
    );

    assert.deepEqual(statsEarned(before, after), new Map());
  });

  it("earns nothing for a settings edit", () => {
    const before = table({ phase: "lobby" });
    const after = unwrap(updateSettings(before, "ada", { ...before.settings, handSize: 6 }));

    assert.deepEqual(statsEarned(before, after), new Map());
  });

  it("earns nothing for a deal", () => {
    const scored = unwrap(callYaniv(table(), "ada"));

    const dealt = unwrap(startNextRound(scored, "ada", mulberry32(1)));

    assert.deepEqual(statsEarned(scored, dealt), new Map());
  });

  /** Ada, signed in, alone at the table with Grace, and holding a legal call. */
  const twoOfUs = (): GameState =>
    makeState({
      players: [{ id: "ada", accountId: "acc-ada" }, { id: "grace", accountId: "acc-grace" }],
      hands: { ada: ["hearts-A"], grace: ["spades-K"] },
    });

  it("earns no Yaniv call for a departure that ends the match mid-round", () => {
    const before = unwrap(
      startNextRound(unwrap(callYaniv(twoOfUs(), "ada")), "ada", mulberry32(1)),
    );

    const after = unwrap(removePlayer(before, "grace"));
    assert.equal(after.phase, "gameEnd", "the departure took the phase off playing");

    assert.equal(statsEarned(before, after).get("acc-ada")?.yanivCalls, undefined);
  });

  /**
   * The case the scorecard key exists for: the last opponent leaving a scored round ends
   * the match with Ada's call still standing on the state. Reading "the round has a
   * result and the phase moved" as a call would count that call twice.
   */
  it("earns no second Yaniv call for a departure after the round was scored", () => {
    const before = unwrap(callYaniv(twoOfUs(), "ada"));

    const after = unwrap(removePlayer(before, "grace"));
    assert.equal(after.phase, "gameEnd", "the departure ended the match");
    assert.equal(after.lastRoundResult?.callerId, "ada", "with Ada's call still standing");

    assert.equal(statsEarned(before, after).get("acc-ada")?.yanivCalls, undefined);
  });
});
