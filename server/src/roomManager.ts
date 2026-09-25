import { randomBytes, randomUUID } from "node:crypto";
import {
  HAND_SIZE,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PLAYERS,
  MAX_SCORE,
  YANIV_THRESHOLD,
  effectiveBotCount,
  normalizeDisplayName,
  type RoomSettings,
} from "@yaniv/shared";
import { BOT_NAMES, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "./config.ts";
import { err, ok, type Result } from "./result.ts";
import { randomInt, systemRng, type Rng } from "./rng.ts";
import type { ActionResult, GameState, GameStateLobby, Player } from "./state.ts";
import { inMatch } from "./state.ts";

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
   * A fresh seat, credentialed. The one place a `Player` is built, so an id, a resume
   * token or the account behind it cannot be left off one of the three ways a seat comes
   * into existence — the same reason all three are required on `Player` in the first place.
   */
  private newSeat(name: string, isBot: boolean, accountId: string | null): Player {
    return {
      id: this.newPlayerId(),
      name,
      score: 0,
      isBot,
      accountId,
      // A fresh seat is in the match and has given nothing up. Written out rather than
      // defaulted anywhere, on the same grounds as `isBot`: a seat whose standing has to
      // be inferred is a seat somebody has to remember to fill in.
      outInRound: null,
      departed: false,
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
   *
   * `accountId` is who took the seat, `null` for a guest, and **required** rather than
   * defaulted on ADR-0013's grounds: a call site that forgot it would seat every signed-in
   * player as a guest, and nothing would say so. The name is whatever the caller settled on
   * — for an account, its own display name, which the transport knows and this does not.
   */
  createRoom(
    hostName: string,
    accountId: string | null,
  ): Result<{
    roomCode: string;
    playerId: string;
    resumeToken: string;
    state: GameState;
  }> {
    const name = normalizeDisplayName(hostName);
    if (name === null) {
      return err("INVALID_NAME", `Name must be 1-${MAX_DISPLAY_NAME_LENGTH} characters`);
    }

    const roomCode = this.generateRoomCode();
    const host = this.newSeat(name, false, accountId);

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
      // A room starts on a blank sheet, and the first deal keeps it blank: the ledger is
      // written by scoring a round and by nothing before it. docs/adr/0017.
      scorecard: [],
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

  /**
   * Seat a player in an existing room — or, for an account that already holds a seat
   * here, hand that seat back rather than seating it twice (docs/adr/0022).
   *
   * The account *is* that seat's credential, so joining again is claiming it, and it is
   * answered before any refusal of a *new* seat: a match under way or a full table is no
   * reason to keep a player out of the seat they are sitting in. `resumed` says which
   * happened, for the transport's announcement; nothing is changed by a resumption. Only a
   * seat still somebody's counts — one given up stays given up, as it does to `resumeSeat`.
   */
  joinRoom(
    roomCode: string,
    playerName: string,
    accountId: string | null,
  ): Result<{ playerId: string; resumeToken: string; state: GameState; resumed: boolean }> {
    const room = this.rooms.get(roomCode);
    if (!room) return err("ROOM_NOT_FOUND", `No room with code ${roomCode}`);

    const held =
      accountId === null
        ? undefined
        : room.state.players.find((p) => p.accountId === accountId && !p.departed);
    if (held) {
      return ok({
        playerId: held.id,
        resumeToken: held.resumeToken,
        state: room.state,
        resumed: true,
      });
    }

    const name = normalizeDisplayName(playerName);
    if (name === null) {
      return err("INVALID_NAME", `Name must be 1-${MAX_DISPLAY_NAME_LENGTH} characters`);
    }
    if (room.state.phase !== "lobby") {
      return err("WRONG_PHASE", "That game has already started");
    }
    if (room.state.players.length >= MAX_PLAYERS) {
      return err("ROOM_FULL", `Room is full (${MAX_PLAYERS} players)`);
    }

    const player = this.newSeat(name, false, accountId);
    room.state = { ...room.state, players: [...room.state.players, player] };
    return ok({
      playerId: player.id,
      resumeToken: player.resumeToken,
      state: room.state,
      resumed: false,
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
    // Counted over the seats that are actually going to play. Only ever called from a
    // lobby, where those are all of them — but a roster is append-only from the first
    // deal, so counting it raw would one day fill a table against seats that have gone.
    const playing = state.players.filter(inMatch);
    const humanCount = playing.filter((p) => !p.isBot).length;
    const targetSize = humanCount + effectiveBotCount(state.settings, humanCount);
    if (playing.length >= targetSize) return state;

    // Two counters that deliberately disagree: seats are appended to the whole roster,
    // and counted against the table that is going to play.
    const players = [...state.players];
    let seated = playing.length;
    while (seated < targetSize) {
      // Named off every bot the room has ever had, seats that have gone included, so two
      // bots cannot end up sharing a name. Safe to index directly: a table holds at most
      // MAX_PLAYERS seats and its creator is human, so BOT_NAMES has a name for each.
      const taken = players.filter((p) => p.isBot).length;
      players.push(this.newSeat(BOT_NAMES[taken]!, true, null));
      seated++;
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
