/**
 * Play a match — against bots, or against other people — over a real socket connection.
 *
 * Start a server in one terminal (`npm run serve`), then this in another:
 *
 *   node scripts/playSocket.ts --name Ada                  open the interactive main menu
 *   node scripts/playSocket.ts --name Ada --create         create a room immediately
 *   node scripts/playSocket.ts --name Ada --join WXYZ      join the room with that code
 *   node scripts/playSocket.ts --name Ada --url http://h   connect somewhere else
 *
 * Bare `--name` lands on a main menu (`create` / `join <code>` / `q`), rather than
 * silently creating a room. `--join`/`--create` skip straight past it, same as always.
 * Whoever creates a room is shown its code; read it out and everyone else joins it,
 * either with `--join` or by typing `join <code>` at their own menu. Every empty seat is
 * filled with a bot when the host starts, so playing alone needs no extra ceremony.
 *
 * This is a debugging tool and a worked reference for the connection flow a real
 * client will need — deliberately disposable, not a preview of any final UI.
 *
 * Like `src/index.ts`, this file is composition only: it binds argv, stdin/stdout and
 * a socket, and hands them to `cli/session.ts`, which holds all the behaviour and all
 * the tests.
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { io as connectClient } from "socket.io-client";
import { runSession, type EntryMode, type YanivClientSocket } from "./cli/session.ts";

/**
 * A value that itself looks like a flag is treated as absent, not as the value — a typo
 * like `--name --join WXYZ` (name's argument omitted) would otherwise silently read
 * "--join" as the player's name instead of surfacing as a missing value.
 */
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value?.startsWith("--") ? undefined : value;
}

const url = flag("--url") ?? `http://localhost:${process.env.PORT ?? 3000}`;

// Required rather than defaulted: this name is what the rest of the table sees, and a
// placeholder would be stored by the server as the player's real name. Refusing here
// keeps that out of the session driver too — see `SessionOptions` in `cli/session.ts`.
const playerName = flag("--name");
if (playerName === undefined) {
  console.error("\x1b[31m--name is required, e.g. --name Ada\x1b[0m");
  process.exit(1);
}

// An empty `--join` is a mistake rather than a default — silently falling through to
// the main menu is the one outcome a player who typed `--join` cannot have wanted.
const joinRoomCode = flag("--join");
if (process.argv.includes("--join") && joinRoomCode === undefined) {
  console.error("\x1b[31m--join needs a room code, e.g. --join WXYZ\x1b[0m");
  process.exit(1);
}

if (process.argv.includes("--join") && process.argv.includes("--create")) {
  console.error("\x1b[31m--join and --create cannot both be given\x1b[0m");
  process.exit(1);
}

// Neither flag: the interactive main menu decides, rather than the old implicit
// "bare --name creates a room" behavior.
const entry: EntryMode | undefined =
  joinRoomCode !== undefined
    ? { kind: "join", roomCode: joinRoomCode }
    : process.argv.includes("--create")
      ? { kind: "create" }
      : undefined;

// `io()` is not generic in socket.io-client 4, so the event contract is applied here,
// at the one point where an untyped socket enters the harness.
const socket = connectClient(url, {
  transports: ["websocket"],
}) as YanivClientSocket;

socket.on("connect_error", (error) => {
  console.error(`\x1b[31mcannot reach ${url}: ${error.message}\x1b[0m`);
  console.error("is the server running? try: npm run serve --workspace=@yaniv/server");
  process.exit(1);
});

const rl = readline.createInterface({ input: stdin, output: stdout });

/**
 * Pull from the line iterator rather than `rl.question()`: question() only captures a
 * line if one arrives while it is pending, so piped input — which readline delivers all
 * at once — silently loses lines. Resolving null at end of input makes Ctrl-D quit.
 */
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt: string): Promise<string | null> => {
  stdout.write(prompt);
  const next = await lines.next();
  return next.done ? null : next.value;
};

await new Promise<void>((resolve) => socket.on("connect", () => resolve()));

console.log(
  "\x1b[2mcommands: 'start' begins the match once everyone has joined · " +
    "'1 3' discards those cards and draws from the deck · " +
    "add 't1'/'t2' to take a face-up card instead · 'yaniv' to call · 'q' to quit\x1b[0m",
);

try {
  await runSession(
    socket,
    { ask, output: (text) => console.log(text) },
    // Spread rather than passed as `undefined`: an absent flag has to arrive as an
    // absent option, which is what the session reads as "open the main menu".
    { playerName, ...(entry === undefined ? {} : { entry }) },
  );
} finally {
  rl.close();
  socket.disconnect();
}
