import { randomBytes, randomUUID } from "node:crypto";
import {
  HAND_SIZE,
  MAX_PLAYERS,
  MAX_SCORE,
  YANIV_THRESHOLD,
  effectiveBotCount,
  type RoomSettings,
} from "@yaniv/shared";
import { BOT_NAMES, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "./config.ts";
import { err, ok, type Result } from "./result.ts";
import { randomInt, systemRng, type Rng } from "./rng.ts";
import type { ActionResult, GameState, GameStateLobby, Player } from "./state.ts";

const MAX_NAME_LENGTH = 20;
const MAX_CODE_ATTEMPTS = 100;

/**
 * Bytes behind a resume token. Unlike a room code — short enough to read aloud, and
 * guarded by nothing more than being live — a token is a credential for one seat, so it
 * is sized to be unguessable rather than typeable, and drawn from a CSPRNG rather than
 * the room's `Rng`, which is seeded in tests and reproducible on purpose.
 */
const RESUME_TOKEN_BYTES = 32;

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
  /**
   * Override for deterministic tests, the same way `newPlayerId` is — a test that wants
   * to prove a token never reaches a client has to be able to name the string it is
   * looking for. Defaults to a CSPRNG.
   */
  newResumeToken?: () => string;
  /** Override to give each room a seeded rng in tests. */
  newRoomRng?: () => Rng;
  /**
   * Overrides layered onto `createRoom`'s default `RoomSettings` seed. `updateSettings`
   * is how a host raises `botCount` above its zero default (docs/adr/0006), but no client
   * emits it yet — so a harness that wants a room's lone human sitting down against a bot
   * uses this instead of driving the wire for every room it creates.
   */
  defaultSettings?: Partial<RoomSettings>;
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
  private readonly newResumeToken: () => string;
  private readonly newRoomRng: () => Rng;
  private readonly defaultSettings: Partial<RoomSettings>;

  constructor(options: RoomManagerOptions = {}) {
    this.rng = options.rng ?? systemRng;
    this.newPlayerId = options.newPlayerId ?? (() => randomUUID());
    this.newResumeToken =
      options.newResumeToken ??
      (() => randomBytes(RESUME_TOKEN_BYTES).toString("base64url"));
    this.newRoomRng = options.newRoomRng ?? (() => this.rng);
    this.defaultSettings = options.defaultSettings ?? {};
  }

  /**
   * A fresh seat, credentialed. The one place a `Player` is built, so an id or a resume
   * token cannot be left off one of the three ways a seat comes into existence — the
   * same reason both fields are required on `Player` in the first place.
   */
  private newSeat(name: string, isBot: boolean): Player {
    return {
      id: this.newPlayerId(),
      name,
      score: 0,
      isBot,
      resumeToken: this.newResumeToken(),
    };
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

  /**
   * A newly seated player, as the transport needs them: who they are, the credential
   * that lets them come back to the seat, and the room they are now in.
   *
   * The token is handed back from here rather than dug out of `state` by the caller,
   * so the one place it is issued is also the one place it is given away.
   */
  createRoom(
    hostName: string,
  ): Result<{
    roomCode: string;
    playerId: string;
    resumeToken: string;
    state: GameState;
  }> {
    const name = normalizeName(hostName);
    if (name === null) {
      return err("INVALID_NAME", `Name must be 1-${MAX_NAME_LENGTH} characters`);
    }

    const roomCode = this.generateRoomCode();
    const host = this.newSeat(name, false);

    const state: GameStateLobby = {
      roomCode,
      phase: "lobby",
      hostId: host.id,
      players: [host],
      // Today's constants, seeded as defaults — except `botCount`, which defaults to
      // zero rather than "fill to six". docs/adr/0006.
      settings: {
        handSize: HAND_SIZE,
        yanivThreshold: YANIV_THRESHOLD,
        maxScore: MAX_SCORE,
        botCount: 0,
        ...this.defaultSettings,
      },
      roundNumber: 0,
      round: null,
      lastRoundResult: null,
      winnerIds: null,
    };

    this.rooms.set(roomCode, { state, rng: this.newRoomRng() });
    return ok({
      roomCode,
      playerId: host.id,
      resumeToken: host.resumeToken,
      state,
    });
  }

  joinRoom(
    roomCode: string,
    playerName: string,
  ): Result<{ playerId: string; resumeToken: string; state: GameState }> {
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

    const player = this.newSeat(name, false);
    room.state = { ...room.state, players: [...room.state.players, player] };
    return ok({
      playerId: player.id,
      resumeToken: player.resumeToken,
      state: room.state,
    });
  }

  /**
   * `state` with up to `settings.botCount` bots seated in empty chairs, each issued a
   * player id and a resume token exactly the way a human join is — nothing reconnects on
   * a bot's behalf, but a seat without a token is not a seat.
   *
   * `effectiveBotCount` reevaluates that setting against the room's current human count
   * rather than trusting a stored value that may since have gone stale (docs/adr/0006) —
   * a room's `botCount` defaults to zero, so a freshly created room seats none until a
   * host raises it.
   *
   * Pure: nothing is stored. Callers fold it into a transition passed to `apply`, so a
   * start that is then rejected discards the seating along with everything else, rather
   * than leaving a table filled on the back of a refused call.
   */
  seatBots(state: GameState): GameState {
    const humanCount = state.players.filter((p) => !p.isBot).length;
    const targetSize = humanCount + effectiveBotCount(state.settings, humanCount);
    if (state.players.length >= targetSize) return state;

    const players = [...state.players];
    while (players.length < targetSize) {
      // Safe to index directly: a table holds at most MAX_PLAYERS seats and its creator
      // is human, so BOT_NAMES has a name for every seat a bot can occupy.
      const taken = players.filter((p) => p.isBot).length;
      players.push(this.newSeat(BOT_NAMES[taken]!, true));
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
