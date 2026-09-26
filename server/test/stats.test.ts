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

  it("credits a signed-in player's scored call with one Yaniv call", () => {
    const before = table();

    const earned = statsEarned(before, unwrap(callYaniv(before, "ada")));

    assert.deepEqual(earned, new Map([["acc-ada", { yanivCalls: 1 }]]));
  });

  it("credits a call that was Assafed with a Yaniv call all the same", () => {
    const before = table({
      hands: { ada: ["hearts-A", "hearts-2"], grace: ["spades-A"], bob: ["clubs-J"] },
    });
    const after = unwrap(callYaniv(before, "ada"));
    assert.equal(after.lastRoundResult!.assaferId, "grace", "the round is Assafed");

    assert.equal(statsEarned(before, after).get("acc-ada")?.yanivCalls, 1);
  });

  it("credits a bot's call to nobody", () => {
    const before = table({ currentTurnPlayerId: "bob", hands: { bob: ["clubs-A"] } });

    assert.deepEqual(statsEarned(before, unwrap(callYaniv(before, "bob"))), new Map());
  });

  it("credits a guest's call to nobody", () => {
    const before = table({ currentTurnPlayerId: "grace", hands: { grace: ["spades-A"] } });

    assert.deepEqual(statsEarned(before, unwrap(callYaniv(before, "grace"))), new Map());
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
