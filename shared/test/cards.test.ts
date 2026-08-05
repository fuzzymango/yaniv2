import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rankToValue } from "../src/cards.ts";

describe("rankToValue", () => {
  it("scores ace as 1, faces as 10, jokers as 0", () => {
    assert.equal(rankToValue("A"), 1);
    assert.equal(rankToValue("7"), 7);
    assert.equal(rankToValue("10"), 10);
    assert.equal(rankToValue("J"), 10);
    assert.equal(rankToValue("Q"), 10);
    assert.equal(rankToValue("K"), 10);
    assert.equal(rankToValue("Joker"), 0);
  });
});
