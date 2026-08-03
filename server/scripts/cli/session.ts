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
import { parseCommand, parseMainMenuCommand } from "./commands.ts";
import { renderMainMenu, renderView } from "./render.ts";

export type YanivClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface SessionIo {
  /**
   * Prompt for a line. Resolves `null` when input is exhausted, i.e. Ctrl-D.
   *
   * Called serially: the session never has two prompts outstanding at once, so an
   * implementation may assume the line it reads answers the last prompt it printed. A
   * prompt the session stops waiting on — the room closing under it — is carried over
   * to the next screen rather than abandoned, precisely to keep that true.
   */
  ask: (prompt: string) => Promise<string | null>;
  output: (text: string) => void;
}

type AckResult<T> = { ok: true; value: T } | { ok: false; error: GameError };

/** Emit an action and resolve with the server's ack. */
const send = (emit: (ack: Ack<null>) => void) =>
  new Promise<AckResult<null>>((resolve) => emit(resolve));

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

/**
 * A one-shot announcement that may never be made, with its trigger held outside the
 * promise — which is how a server event the loop cannot poll for becomes something it
 * can wait on alongside the player's next line.
 */
interface Notice {
  arrived: Promise<string>;
  announce: (reason: string) => void;
}

function notice(): Notice {
  let announce!: (reason: string) => void;
  const arrived = new Promise<string>((resolve) => {
    announce = resolve;
  });
  return { arrived, announce };
}

/** How a room gets entered — chosen either at the main menu or by an argv flag. */
export type EntryMode =
  | { kind: "create" }
  /**
   * Case-insensitive: a code is read aloud and typed back in, so it should not matter
   * how it arrives.
   */
  | { kind: "join"; roomCode: string };

export interface SessionOptions {
  /**
   * Required, and deliberately without a default: a placeholder name here would be
   * stored by the server as this player's real name, and everyone else at the table
   * would see it. Whoever binds argv has to ask for one.
   */
  playerName: string;
  /**
   * How to enter a room the very first time through the session loop — supplied by
   * `--join`/`--create`. Omitted means open the interactive main menu instead, which is
   * the only source of an entry mode on every pass after the first (see `runSession`).
   */
  entry?: EntryMode;
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
   * Who came and went. Neither is a position: the roster arrives right behind each of
   * them as a fresh view, so these are only the nudges — without them a seat filling or
   * emptying is easy to miss between two otherwise similar frames.
   */
  socket.on("playerJoined", (name) => io.output(dim(`  ${name} joined`)));
  socket.on("playerLeft", (name) => io.output(dim(`  ${name} left`)));

  /**
   * Being closed out of the room we are sitting in — the host leaving, today the only
   * cause. Replaced on every entry (see the loop below), and the handler reads the
   * variable rather than capturing one notice, so a room that has closed can never end
   * the next one.
   */
  let roomClosed = notice();
  socket.on("roomClosed", (reason) => roomClosed.announce(reason));

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
   * Forget the room on the way back to the menu. A session outlives the rooms it visits
   * now, and a position left behind is one the next room's first `waitFor` would match
   * before that room has broadcast anything — prompting a player against a table they
   * are no longer sitting at.
   */
  const forgetRoom = () => {
    current = null;
  };

  /**
   * The prompt a player is already sitting in front of, if one was left outstanding when
   * the room closed under them.
   *
   * `io.ask` is a serial contract: at most one prompt is outstanding at a time. A second
   * one issued while the first is still waiting would queue behind it at the terminal,
   * and the next line typed would answer the prompt nobody is listening to any more —
   * swallowing it. So the menu picks up the request the lobby left behind rather than
   * making its own.
   */
  let outstanding: Promise<string | null> | null = null;
  const ask = (prompt: string) => {
    const asked = outstanding ?? io.ask(prompt);
    outstanding = null;
    return asked;
  };

  /**
   * Get a seat: a room of our own, or the one whose code we were given. The code is
   * upper-cased on the way out so it can be typed in however it was heard.
   *
   * A join is acked with a player id only, so the code we asked for is the code we are
   * in — there is nowhere else the server could have put us.
   */
  const enterRoom = (
    mode: EntryMode,
  ): Promise<AckResult<{ roomCode: string; playerId: string }>> => {
    if (mode.kind === "create") {
      return new Promise((resolve) => socket.emit("createRoom", playerName, resolve));
    }
    const joining = mode.roomCode.toUpperCase();
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

  /**
   * The screen before any room exists. Reprompts through a blank line or nonsense on
   * its own — only `create`, `join <code>` and quitting ever return from here — so a
   * caller never has to loop on `noop`/`invalid` itself.
   */
  const promptMainMenu = async (): Promise<EntryMode | { kind: "quit" }> => {
    for (;;) {
      io.output(renderMainMenu());
      const line = await ask("  > ");
      if (line === null) return { kind: "quit" };

      const command = parseMainMenuCommand(line);
      if (command.kind === "noop") continue;
      if (command.kind === "invalid") {
        io.output(red(`  ✗ ${command.message}`));
        continue;
      }
      if (command.kind === "quit") return { kind: "quit" };
      return command.kind === "create"
        ? { kind: "create" }
        : { kind: "join", roomCode: command.roomCode };
    }
  };

  // Only the very first pass through this loop can be driven by an argv-supplied entry
  // mode (`--join`/`--create`); every later pass — a bad code typed at the menu, or a
  // room left behind for it — always goes through the interactive menu, since there is
  // no flag to fall back on a second time.
  let pendingEntry = options.entry;

  for (;;) {
    const interactive = pendingEntry === undefined;
    const mode = pendingEntry ?? (await promptMainMenu());
    pendingEntry = undefined;

    if (mode.kind === "quit") return;

    const entered = await enterRoom(mode);
    if (!entered.ok) {
      io.output(red(`✗ ${entered.error.code}: ${entered.error.message}`));
      // A code mistyped at the menu is worth a second try; one that arrived on the
      // command line is not — the flag itself was wrong, and silently retrying it
      // would hide that rather than surface it.
      if (interactive) continue;
      return;
    }
    const { roomCode, playerId } = entered.value;
    io.output(dim(`room ${roomCode} · you are ${playerName}`));

    // This room's own closing notice, not whatever became of the last one.
    roomClosed = notice();

    /**
     * A position worth prompting at: the lobby we are waiting in, our turn, or a round
     * or match that has ended. Anything else is somebody else moving, which the
     * broadcast handler has already shown.
     *
     * The lobby counts for every player, not just the host. Only the host's `start`
     * will be accepted, but everyone still needs a prompt to leave or quit from — and
     * being told `NOT_HOST` is how a guest finds out the rule, rather than the harness
     * guessing at it.
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
      // A finished match still ends the session outright, as it always has. The lobby
      // is the one screen `menu` is offered from so far; the same way out of `gameEnd`,
      // alongside playing again, is a later ticket's job.
      if (prompted.view.phase === "gameEnd") return;

      const prompt =
        prompted.view.phase === "roundEnd"
          ? dim("  [enter] for the next round ")
          : "  > ";

      /**
       * The line, or the room going away underneath it — whichever lands first.
       *
       * A player waiting in a lobby is by definition doing nothing, so a host closing it
       * has to reach them where they are: waiting for them to press a key first would
       * leave them looking at a table that had quietly stopped answering. The prompt
       * outlives the race — it is still in front of the player — so it is handed on to
       * the menu rather than dropped.
       */
      const asked = ask(prompt);
      const answer = await Promise.race([
        asked.then((line) => ({ kind: "line", line }) as const),
        roomClosed.arrived.then((reason) => ({ kind: "closed", reason }) as const),
      ]);

      if (answer.kind === "closed") {
        io.output(dim(`  room closed — ${answer.reason}`));
        outstanding = asked;
        forgetRoom();
        break;
      }

      const line = answer.line;
      if (line === null) return;

      /**
       * Read the line against the newest position, not the one that prompted for it.
       * With another human at the table the board can move while a player is typing —
       * the host starting the match, or dealing the next round — and a typed line
       * should mean what the screen in front of them says it means. Mid-round the two
       * are the same position anyway: nobody else can act while the turn is ours.
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
        else if (command.kind === "menu") socket.emit("exitToMenu", ack);
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

      /**
       * The one action whose success ends our interest in this room rather than moving
       * it on. What it cost everyone else — a freed seat, or the room itself — is the
       * server's decision and not something we are told; either way we are out, and the
       * menu is where a player without a room belongs.
       */
      if (command.kind === "menu") {
        forgetRoom();
        break;
      }

      actedOn = version;
    }
  }
}
