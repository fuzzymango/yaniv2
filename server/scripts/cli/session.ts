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
  playerName?: string;
}

export async function runSession(
  socket: YanivClientSocket,
  io: SessionIo,
  options: SessionOptions = {},
): Promise<void> {
  const playerName = options.playerName ?? "You";

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

  const created = await new Promise<AckResult<{ roomCode: string; playerId: string }>>(
    (resolve) => socket.emit("createRoom", playerName, resolve),
  );
  if (!created.ok) {
    io.output(red(`✗ ${created.error.code}: ${created.error.message}`));
    return;
  }
  const { roomCode, playerId } = created.value;
  io.output(dim(`room ${roomCode} · you are ${playerName}`));

  const started = await send((ack) => socket.emit("startGame", ack));
  if (!started.ok) {
    io.output(red(`✗ ${started.error.code}: ${started.error.message}`));
    return;
  }

  // The turn is ours, the round is over, or the match is — anything else is a bot
  // moving, which the broadcast handler has already shown.
  const isOurMove = (view: PlayerGameView) =>
    view.currentTurnPlayerId === playerId ||
    view.phase === "roundEnd" ||
    view.phase === "gameEnd";

  /** The position we last successfully acted on; we never act on it twice. */
  let actedOn = 0;

  for (;;) {
    const { view, version } = await waitFor(
      (position) => position.version > actedOn && isOurMove(position.view),
    );
    if (view.phase === "gameEnd") return;

    const prompt =
      view.phase === "roundEnd" ? dim("  [enter] for the next round ") : "  > ";
    const line = await io.ask(prompt);
    if (line === null) return;

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
