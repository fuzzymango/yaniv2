/**
 * The harness's client session: everything between a connected socket and a developer
 * at a keyboard.
 *
 * This is a real client and nothing more. It learns the game only from
 * `gameStateUpdate` broadcasts and acts only by emitting events off the shared
 * contract — there is no import of `RoomManager` or `GameState` here, and there must
 * never be one, or the harness would stop being a test of the transport.
 *
 * Input and output are injected rather than bound to stdin/stdout, which is what lets
 * the session be driven by a test as well as by a person. Binding the real streams is
 * the entrypoint's job. See `scripts/playSocket.ts`.
 */

import type {
  Ack,
  ClientToServerEvents,
  GameError,
  PlayerGameView,
  ServerToClientEvents,
} from "@yaniv/shared";
import type { Socket } from "socket.io-client";
import { parseCommand } from "./commands.ts";
import { renderView } from "./render.ts";

export type YanivClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface SessionIo {
  /** Prompt for a line. Resolves `null` when input is exhausted, i.e. Ctrl-D. */
  ask: (prompt: string) => Promise<string | null>;
  output: (text: string) => void;
}

type AckResult<T> = { ok: true; value: T } | { ok: false; error: GameError };

/** Emit an action and resolve with the server's ack. */
const send = (emit: (ack: Ack<null>) => void) =>
  new Promise<AckResult<null>>((resolve) => emit(resolve));

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

export interface SessionOptions {
  /**
   * Required, and deliberately without a default: a placeholder name here would be
   * stored by the server as this player's real name, and everyone else at the table
   * would see it. Whoever binds argv has to ask for one.
   */
  playerName: string;
  /**
   * Join this room instead of creating one. Case-insensitive: a code is read aloud and
   * typed back in, so it should not matter how it arrives.
   */
  joinRoomCode?: string;
}

export async function runSession(
  socket: YanivClientSocket,
  io: SessionIo,
  options: SessionOptions,
): Promise<void> {
  const { playerName } = options;

  /**
   * A view plus how many broadcasts had arrived when it did.
   *
   * The counter is what stops the session acting twice on one position. The server
   * acks an action *before* it broadcasts the result, so for a moment after a move the
   * last view still shows our turn — prompting off it would ask the developer to play
   * cards they have already discarded, and the server would rightly refuse. Waiting
   * for a strictly newer position closes that window.
   */
  interface Position {
    view: PlayerGameView;
    version: number;
  }

  let current: Position | null = null;
  const waiters: Array<{
    matches: (position: Position) => boolean;
    resolve: (position: Position) => void;
  }> = [];

  /**
   * The one thing the server tells us that is not a position. The roster arrives right
   * behind it as a fresh view, so this is only the nudge — without it an arrival is easy
   * to miss among the frames.
   */
  socket.on("playerJoined", (name) => io.output(dim(`  ${name} joined`)));

  /**
   * Every broadcast is rendered the moment it lands. That is the point of the harness:
   * a chain of bot turns arrives as one update per move, so printing on arrival shows
   * them as separate moves rather than a single jump to the final position.
   */
  socket.on("gameStateUpdate", (view) => {
    const position = { view, version: (current?.version ?? 0) + 1 };
    current = position;
    io.output(renderView(view));

    const pending = waiters.splice(0);
    for (const waiter of pending) {
      if (waiter.matches(position)) waiter.resolve(position);
      else waiters.push(waiter);
    }
  });

  /** Resolve as soon as the position satisfies `matches` — now, or on a later update. */
  const waitFor = (matches: (position: Position) => boolean) =>
    new Promise<Position>((resolve) => {
      if (current && matches(current)) resolve(current);
      else waiters.push({ matches, resolve });
    });

  /**
   * Get a seat: a room of our own, or the one whose code was read out to us. The code
   * is upper-cased on the way out so it can be typed in however it was heard.
   *
   * A join is acked with a player id only, so the code we asked for is the code we are
   * in — there is nowhere else the server could have put us.
   */
  const enterRoom = (): Promise<AckResult<{ roomCode: string; playerId: string }>> => {
    const joining = options.joinRoomCode?.toUpperCase();
    if (joining === undefined) {
      return new Promise((resolve) => socket.emit("createRoom", playerName, resolve));
    }
    return new Promise((resolve) =>
      socket.emit("joinRoom", joining, playerName, (result) =>
        resolve(
          result.ok
            ? { ok: true, value: { roomCode: joining, playerId: result.value.playerId } }
            : result,
        ),
      ),
    );
  };

  const entered = await enterRoom();
  if (!entered.ok) {
    io.output(red(`✗ ${entered.error.code}: ${entered.error.message}`));
    return;
  }
  const { roomCode, playerId } = entered.value;
  io.output(dim(`room ${roomCode} · you are ${playerName}`));

  /**
   * A position worth prompting at: the lobby we are waiting in, our turn, or a round
   * or match that has ended. Anything else is somebody else moving, which the broadcast
   * handler has already shown.
   *
   * The lobby counts for every player, not just the host. Only the host's `start` will
   * be accepted, but everyone still needs a prompt to quit from — and being told
   * `NOT_HOST` is how a guest finds out the rule, rather than the harness guessing at it.
   */
  const isOurMove = (view: PlayerGameView) =>
    view.phase === "lobby" ||
    view.currentTurnPlayerId === playerId ||
    view.phase === "roundEnd" ||
    view.phase === "gameEnd";

  /** The position we last successfully acted on; we never act on it twice. */
  let actedOn = 0;

  for (;;) {
    const prompted = await waitFor(
      (position) => position.version > actedOn && isOurMove(position.view),
    );
    if (prompted.view.phase === "gameEnd") return;

    const prompt =
      prompted.view.phase === "roundEnd"
        ? dim("  [enter] for the next round ")
        : "  > ";
    const line = await io.ask(prompt);
    if (line === null) return;

    /**
     * Read the line against the newest position, not the one that prompted for it. With
     * another human at the table the board can move while a player is typing — the host
     * starting the match, or dealing the next round — and a typed line should mean what
     * the screen in front of them says it means. Mid-round the two are the same
     * position anyway: nobody else can act while the turn is ours.
     */
    const { view, version } = current ?? prompted;

    const command = parseCommand(line, view);
    if (command.kind === "quit") return;
    if (command.kind === "noop") continue;
    if (command.kind === "invalid") {
      io.output(red(`  ✗ ${command.message}`));
      continue;
    }

    const result = await send((ack) => {
      if (command.kind === "turn") socket.emit("takeTurn", command.action, ack);
      else if (command.kind === "yaniv") socket.emit("callYaniv", ack);
      else if (command.kind === "start") socket.emit("startGame", ack);
      else socket.emit("startNextRound", ack);
    });

    /**
     * A refused action is news, not a crash. The server published nothing, so the
     * position is unchanged and the turn is still ours — print the code and prompt
     * again.
     */
    if (!result.ok) {
      io.output(red(`  ✗ ${result.error.code}: ${result.error.message}`));
      continue;
    }

    actedOn = version;
  }
}
