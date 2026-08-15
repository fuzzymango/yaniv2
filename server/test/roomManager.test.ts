import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PLAYERS } from "@yaniv/shared";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "../src/config.ts";
import { startGame } from "../src/game.ts";
import { RoomManager } from "../src/roomManager.ts";
import { err, ok } from "../src/result.ts";
import { mulberry32 } from "../src/rng.ts";
import { expectErr, makeState, unwrap } from "./helpers.ts";

function manager(): RoomManager {
  let n = 0;
  let tokens = 0;
  return new RoomManager({
    rng: mulberry32(2024),
    newPlayerId: () => `player-${++n}`,
    newResumeToken: () => `token-${++tokens}`,
    newRoomRng: () => mulberry32(7),
  });
}

describe("createRoom", () => {
  it("opens a lobby containing only the host", () => {
    const rooms = manager();
    const { roomCode, playerId, state } = unwrap(rooms.createRoom("Ada"));

    assert.equal(state.phase, "lobby");
    assert.equal(state.roomCode, roomCode);
    assert.equal(state.hostId, playerId);
    assert.deepEqual(
      state.players.map((p) => p.name),
      ["Ada"],
    );
    assert.equal(state.round, null);
    assert.equal(state.roundNumber, 0);
  });

  it("issues a code from the unambiguous alphabet", () => {
    const { roomCode } = unwrap(manager().createRoom("Ada"));
    assert.equal(roomCode.length, ROOM_CODE_LENGTH);
    for (const char of roomCode) {
      assert.ok(ROOM_CODE_ALPHABET.includes(char), `unexpected char ${char}`);
    }
  });

  it("never reuses a live room code", () => {
    const rooms = manager();
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      codes.add(unwrap(rooms.createRoom("Ada")).roomCode);
    }
    assert.equal(codes.size, 200);
    assert.equal(rooms.roomCount, 200);
  });

  it("rejects a blank or oversized name", () => {
    const rooms = manager();
    expectErr(rooms.createRoom("   "), "INVALID_NAME");
    expectErr(rooms.createRoom("x".repeat(21)), "INVALID_NAME");
  });

  it("trims surrounding whitespace from names", () => {
    const { state } = unwrap(manager().createRoom("  Ada  "));
    assert.equal(state.players[0]!.name, "Ada");
  });
});

describe("joinRoom", () => {
  it("adds a player to an open lobby", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));
    const { playerId, state } = unwrap(rooms.joinRoom(roomCode, "Grace"));

    assert.deepEqual(
      state.players.map((p) => p.name),
      ["Ada", "Grace"],
    );
    assert.equal(state.players[1]!.id, playerId);
    assert.notEqual(state.hostId, playerId);
  });

  it("rejects an unknown room code", () => {
    expectErr(manager().joinRoom("ZZZZ", "Grace"), "ROOM_NOT_FOUND");
  });

  it("rejects a room at capacity", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Host"));
    for (let i = 1; i < MAX_PLAYERS; i++) {
      unwrap(rooms.joinRoom(roomCode, `P${i}`));
    }
    expectErr(rooms.joinRoom(roomCode, "TooMany"), "ROOM_FULL");
  });

  it("rejects joining a game already under way", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));
    unwrap(rooms.joinRoom(roomCode, "Grace"));
    unwrap(rooms.apply(roomCode, (state, rng) => startGame(state, state.hostId, rng)));

    expectErr(rooms.joinRoom(roomCode, "Late"), "WRONG_PHASE");
  });

  it("rejects an invalid name", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));
    expectErr(rooms.joinRoom(roomCode, ""), "INVALID_NAME");
  });
});

describe("resume tokens", () => {
  it("issues the host one when the room is created", () => {
    const { state, playerId } = unwrap(manager().createRoom("Ada"));

    const host = state.players.find((p) => p.id === playerId)!;
    assert.equal(host.resumeToken, "token-1");
  });

  it("issues each joining player their own", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));
    const { state } = unwrap(rooms.joinRoom(roomCode, "Grace"));

    const tokens = state.players.map((p) => p.resumeToken);
    assert.deepEqual(tokens, ["token-1", "token-2"]);
  });

  it("issues one to every bot seat too, so no seat is uncredentialed", () => {
    const rooms = manager();
    const lobby = makeState({
      phase: "lobby",
      players: [{ id: "p1", name: "Ada" }],
      settings: { botCount: MAX_PLAYERS - 1 },
    });

    const tokens = rooms
      .seatBots(lobby)
      .players.filter((p) => p.isBot)
      .map((p) => p.resumeToken);

    assert.equal(tokens.length, MAX_PLAYERS - 1);
    assert.equal(new Set(tokens).size, tokens.length, `not all distinct: ${tokens}`);
  });

  /**
   * The generator is injected in every other test here. This one is about the default:
   * a token is a credential, so guessing one must not be a way into someone's seat.
   */
  it("defaults to a long, unguessable value, distinct for every seat", () => {
    const rooms = new RoomManager();
    const tokens = new Set<string>();

    for (let i = 0; i < 200; i++) {
      const { roomCode, state } = unwrap(rooms.createRoom("Ada"));
      const guest = unwrap(rooms.joinRoom(roomCode, "Grace")).state.players[1]!;
      for (const token of [state.players[0]!.resumeToken, guest.resumeToken]) {
        assert.ok(token.length >= 32, `too short to be a secret: ${token}`);
        tokens.add(token);
      }
    }

    assert.equal(tokens.size, 400, "two seats were issued the same token");
  });

  /** Whole-match fixity is proven over every transition in `integration.test.ts`. */
  it("leaves the seats already taken holding the token they were issued", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));
    unwrap(rooms.joinRoom(roomCode, "Grace"));
    unwrap(rooms.apply(roomCode, (state, rng) => startGame(state, state.hostId, rng)));

    assert.deepEqual(
      rooms.getState(roomCode)!.players.map((p) => p.resumeToken),
      ["token-1", "token-2"],
    );
  });
});

describe("seatBots", () => {
  it("seats nobody when botCount is zero — a freshly created room's default", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));

    const state = rooms.seatBots(rooms.getState(roomCode)!);

    assert.equal(state.players.length, 1);
  });

  it("fills up to botCount bots, not always to the table limit", () => {
    const rooms = manager();
    const lobby = makeState({
      phase: "lobby",
      players: [{ id: "p1", name: "Ada" }],
      settings: { botCount: 3 },
    });

    const state = rooms.seatBots(lobby);

    assert.equal(state.players.length, 4, "the host plus three bots");
    assert.equal(state.players.filter((p) => p.isBot).length, 3);
  });

  it("never seats past MAX_PLAYERS even when botCount asks for more", () => {
    const rooms = manager();
    const lobby = makeState({
      phase: "lobby",
      players: [{ id: "p1", name: "Ada" }],
      settings: { botCount: MAX_PLAYERS + 5 },
    });

    const state = rooms.seatBots(lobby);

    assert.equal(state.players.length, MAX_PLAYERS);
  });

  it("issues each bot its own player id", () => {
    const rooms = manager();
    const lobby = makeState({
      phase: "lobby",
      players: [{ id: "p1", name: "Ada" }],
      settings: { botCount: MAX_PLAYERS - 1 },
    });

    const ids = rooms.seatBots(lobby).players.map((p) => p.id);

    assert.equal(new Set(ids).size, ids.length, `not all distinct: ${ids}`);
  });

  it("gives every bot a distinct name a human could not be mistaken for", () => {
    const rooms = manager();
    const lobby = makeState({
      phase: "lobby",
      players: [{ id: "p1", name: "Ada" }],
      settings: { botCount: MAX_PLAYERS - 1 },
    });

    const names = rooms
      .seatBots(lobby)
      .players.filter((p) => p.isBot)
      .map((p) => p.name);

    assert.equal(new Set(names).size, names.length, `not all distinct: ${names}`);
    for (const name of names) {
      assert.match(name, /bot/i, "a bot's name says it is a bot");
    }
  });

  it("leaves the humans already seated alone", () => {
    const rooms = manager();
    const lobby = makeState({
      phase: "lobby",
      players: [{ id: "p1", name: "Ada" }, { id: "p2", name: "Grace" }],
      settings: { botCount: MAX_PLAYERS },
    });

    const state = rooms.seatBots(lobby);

    assert.equal(state.players.length, MAX_PLAYERS);
    assert.deepEqual(
      state.players.filter((p) => !p.isBot).map((p) => p.name),
      ["Ada", "Grace"],
    );
  });

  it("is a no-op on a table that is already full", () => {
    const rooms = manager();
    const lobby = makeState({
      phase: "lobby",
      players: [{ id: "p1", name: "Ada" }],
      settings: { botCount: MAX_PLAYERS },
    });
    const filled = rooms.seatBots(lobby);

    assert.equal(rooms.seatBots(filled), filled);
  });

  /** Nothing is stored until a caller folds the result into a transition. */
  it("does not seat anyone in the stored room by itself", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));

    rooms.seatBots(rooms.getState(roomCode)!);

    assert.equal(rooms.getState(roomCode)!.players.length, 1);
  });
});

describe("isBot", () => {
  it("marks only the bot seats as bot-controlled", () => {
    const rooms = manager();
    const { roomCode, playerId: hostId } = unwrap(rooms.createRoom("Ada"));
    unwrap(
      rooms.apply(roomCode, (state) =>
        ok(rooms.seatBots({ ...state, settings: { ...state.settings, botCount: 1 } })),
      ),
    );
    const botId = rooms.getState(roomCode)!.players[1]!.id;

    assert.equal(rooms.isBot(roomCode, botId), true);
    assert.equal(rooms.isBot(roomCode, hostId), false);
  });

  it("reports a player id it has never heard of as not a bot", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));

    assert.equal(rooms.isBot(roomCode, "nobody"), false);
    assert.equal(rooms.isBot("ZZZZ", "nobody"), false);
  });
});

describe("apply", () => {
  it("persists the new state when the transition succeeds", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));
    unwrap(rooms.joinRoom(roomCode, "Grace"));

    unwrap(rooms.apply(roomCode, (state, rng) => startGame(state, state.hostId, rng)));

    const state = rooms.getState(roomCode)!;
    assert.equal(state.phase, "playing");
    assert.equal(state.round.hands["player-1"]!.length, 5);
  });

  it("leaves the stored state untouched when the transition fails", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));
    const before = rooms.getState(roomCode);

    // Only one player, so starting is rejected.
    expectErr(
      rooms.apply(roomCode, (state, rng) => startGame(state, state.hostId, rng)),
      "NOT_ENOUGH_PLAYERS",
    );
    assert.equal(rooms.getState(roomCode), before);
    assert.equal(rooms.getState(roomCode)!.phase, "lobby");
  });

  it("does not store a state produced by a rejecting transition", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));
    const before = rooms.getState(roomCode)!;

    rooms.apply(roomCode, (state) => {
      // A transition that both mutates nothing and fails must be a no-op.
      void state;
      return err("WRONG_PHASE", "nope");
    });
    assert.equal(rooms.getState(roomCode), before);
  });

  it("threads the room's own rng into the transition", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));
    let sawRng = false;
    unwrap(
      rooms.apply(roomCode, (state, rng) => {
        sawRng = typeof rng() === "number";
        return ok(state);
      }),
    );
    assert.ok(sawRng);
  });

  it("rejects an unknown room code", () => {
    expectErr(
      manager().apply("ZZZZ", (state) => ok(state)),
      "ROOM_NOT_FOUND",
    );
  });
});

describe("room removal", () => {
  it("forgets a removed room", () => {
    const rooms = manager();
    const { roomCode } = unwrap(rooms.createRoom("Ada"));
    assert.equal(rooms.roomCount, 1);

    rooms.removeRoom(roomCode);

    assert.equal(rooms.roomCount, 0);
    assert.equal(rooms.getState(roomCode), undefined);
    expectErr(rooms.joinRoom(roomCode, "Grace"), "ROOM_NOT_FOUND");
  });
});

describe("room isolation", () => {
  it("keeps each room's state fully independent", () => {
    const rooms = manager();
    const a = unwrap(rooms.createRoom("Ada"));
    const b = unwrap(rooms.createRoom("Grace"));
    unwrap(rooms.joinRoom(a.roomCode, "Alan"));

    assert.equal(rooms.getState(a.roomCode)!.players.length, 2);
    assert.equal(rooms.getState(b.roomCode)!.players.length, 1);
  });
});
