/**
 * Play a match — against bots, or against other people — over a real socket connection.
 *
 * Start a server in one terminal (`npm run serve`), then this in another:
 *
 *   node scripts/playSocket.ts                       connect to localhost:3000
 *   node scripts/playSocket.ts --url http://host:80  connect somewhere else
 *   node scripts/playSocket.ts --name Ada            pick your display name
 *   node scripts/playSocket.ts --join WXYZ           join the room with that code
 *
 * Without `--join` you create a room and are shown its code; read it out and whoever
 * else wants to play passes it to their own `--join`. Every empty seat is filled with a
 * bot when you start, so playing alone needs no extra ceremony.
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
import { runSession, type YanivClientSocket } from "./cli/session.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const url = flag("--url") ?? `http://localhost:${process.env.PORT ?? 3000}`;
const playerName = flag("--name") ?? "You";

// Absence is the whole meaning of this one: no code, no room to join, so create one.
// Which makes an empty `--join` a mistake rather than a default — silently opening a
// brand new room is the one outcome a player who typed `--join` cannot have wanted.
const joinRoomCode = flag("--join");
if (process.argv.includes("--join") && joinRoomCode === undefined) {
  console.error("\x1b[31m--join needs a room code, e.g. --join WXYZ\x1b[0m");
  process.exit(1);
}

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
    // absent option, which is what the session reads as "create a room".
    { playerName, ...(joinRoomCode === undefined ? {} : { joinRoomCode }) },
  );
} finally {
  rl.close();
  socket.disconnect();
}
