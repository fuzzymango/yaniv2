import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountToCredit } from "../src/stats.ts";
import { makeState } from "./helpers.ts";

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
