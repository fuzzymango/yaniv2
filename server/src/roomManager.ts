import { randomUUID } from "node:crypto";
import {
  BOT_NAMES,
  MAX_PLAYERS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "./config.ts";
import { err, ok, type Result } from "./result.ts";
import { randomInt, systemRng, type Rng } from "./rng.ts";
import type { ActionResult, GameState, GameStateLobby, Player } from "./state.ts";

const MAX_NAME_LENGTH = 20;
const MAX_CODE_ATTEMPTS = 100;

interface Room {
  state: GameState;
  /** Per-room rng, so one room's shuffles are reproducible independently. */
  rng: Rng;
}

export interface RoomManagerOptions {
  /** Source of randomness for room codes, and the seed source for each room. */
  rng?: Rng;
  /** Override for deterministic tests. Defaults to `crypto.randomUUID`. */
  newPlayerId?: () => string;
  /** Override to give each room a seeded rng in tests. */
  newRoomRng?: () => Rng;
}

function normalizeName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) return null;
  return trimmed;
}

/**
 * Owns the live rooms. Each room code maps to one fully independent `GameState` plus
 * its own rng. Storage is an in-memory Map: a server restart drops every game in
 * progress. That is a known and accepted limitation, not an oversight.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly rng: Rng;
  private readonly newPlayerId: () => string;
  private readonly newRoomRng: () => Rng;

  constructor(options: RoomManagerOptions = {}) {
    this.rng = options.rng ?? systemRng;
    this.newPlayerId = options.newPlayerId ?? (() => randomUUID());
    this.newRoomRng = options.newRoomRng ?? (() => this.rng);
  }

  private generateRoomCode(): string {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      let code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[randomInt(this.rng, ROOM_CODE_ALPHABET.length)]!;
      }
      if (!this.rooms.has(code)) return code;
    }
    // 32^4 ≈ 1M codes; exhausting 100 attempts means the server is far past capacity.
    throw new Error("Unable to allocate an unused room code");
  }

  createRoom(
    hostName: string,
  ): Result<{ roomCode: string; playerId: string; state: GameState }> {
    const name = normalizeName(hostName);
    if (name === null) {
      return err("INVALID_NAME", `Name must be 1-${MAX_NAME_LENGTH} characters`);
    }

    const roomCode = this.generateRoomCode();
    const host: Player = { id: this.newPlayerId(), name, score: 0, isBot: false };

    const state: GameStateLobby = {
      roomCode,
      phase: "lobby",
      hostId: host.id,
      players: [host],
      roundNumber: 0,
      round: null,
      lastRoundResult: null,
      winnerIds: null,
    };

    this.rooms.set(roomCode, { state, rng: this.newRoomRng() });
    return ok({ roomCode, playerId: host.id, state });
  }

  joinRoom(
    roomCode: string,
    playerName: string,
  ): Result<{ playerId: string; state: GameState }> {
    const room = this.rooms.get(roomCode);
    if (!room) return err("ROOM_NOT_FOUND", `No room with code ${roomCode}`);

    const name = normalizeName(playerName);
    if (name === null) {
      return err("INVALID_NAME", `Name must be 1-${MAX_NAME_LENGTH} characters`);
    }
    if (room.state.phase !== "lobby") {
      return err("WRONG_PHASE", "That game has already started");
    }
    if (room.state.players.length >= MAX_PLAYERS) {
      return err("ROOM_FULL", `Room is full (${MAX_PLAYERS} players)`);
    }

    const player: Player = { id: this.newPlayerId(), name, score: 0, isBot: false };
    room.state = { ...room.state, players: [...room.state.players, player] };
    return ok({ playerId: player.id, state: room.state });
  }

  /**
   * `state` with a bot seated in every empty chair, each issued a player id exactly the
   * way a human join is. This is the whole of a player's opponent setup: they create a
   * room and start the game, and never manage bots. Letting them choose how many
   * opponents they want is intended future work — see issue #2.
   *
   * Pure: nothing is stored. Callers fold it into a transition passed to `apply`, so a
   * start that is then rejected discards the seating along with everything else, rather
   * than leaving a table filled on the back of a refused call.
   */
  seatBots(state: GameState): GameState {
    if (state.players.length >= MAX_PLAYERS) return state;

    const players = [...state.players];
    while (players.length < MAX_PLAYERS) {
      // Safe to index directly: a table holds at most MAX_PLAYERS seats and its creator
      // is human, so BOT_NAMES has a name for every seat a bot can occupy.
      const taken = players.filter((p) => p.isBot).length;
      players.push({
        id: this.newPlayerId(),
        name: BOT_NAMES[taken]!,
        score: 0,
        isBot: true,
      });
    }
    return { ...state, players };
  }

  /** Whether the server plays this seat itself. False for an id it has never heard of. */
  isBot(roomCode: string, playerId: string): boolean {
    const room = this.rooms.get(roomCode);
    return room?.state.players.find((p) => p.id === playerId)?.isBot ?? false;
  }

  getState(roomCode: string): GameState | undefined {
    return this.rooms.get(roomCode)?.state;
  }

  /**
   * Run a state transition against a room and persist it if it succeeds. This is the
   * seam the socket layer uses, so it never touches stored state directly and a
   * rejected action can never leave a room half-updated.
   */
  apply(
    roomCode: string,
    transition: (state: GameState, rng: Rng) => ActionResult,
  ): ActionResult {
    const room = this.rooms.get(roomCode);
    if (!room) return err("ROOM_NOT_FOUND", `No room with code ${roomCode}`);

    const result = transition(room.state, room.rng);
    if (result.ok) {
      room.state = result.value;
    }
    return result;
  }

  removeRoom(roomCode: string): void {
    this.rooms.delete(roomCode);
  }

  get roomCount(): number {
    return this.rooms.size;
  }
}
