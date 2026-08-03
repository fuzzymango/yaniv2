/**
 * The socket CLI harness, driven against a real server.
 *
 * These stand up an actual Socket.io server on an ephemeral port and point the harness
 * at it through a real `socket.io-client`, exactly as `socketServer.test.ts` does — the
 * harness's whole purpose is to be a real client, so a suite that stubbed the socket
 * would be testing a stand-in for the thing under test.
 *
 * Input and output are injected: `ask` stands in for a developer at the keyboard and
 * `output` captures what they would have seen. Nothing reaches into the RoomManager or
 * the session's internals — what the harness knows, it learned over the wire.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { PlayerGameView } from "@yaniv/shared";
import { io as connectClient, type Socket as ClientSocket } from "socket.io-client";
import { YANIV_THRESHOLD } from "../../src/config.ts";
import { RoomManager } from "../../src/roomManager.ts";
import { mulberry32 } from "../../src/rng.ts";
import { handValue } from "../../src/rules.ts";
import { createSocketServer } from "../../src/socketServer.ts";
import { runSession } from "../../scripts/cli/session.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

interface Harness {
  connect: () => Promise<ClientSocket>;
  close: () => Promise<void>;
}

/** A server on an OS-assigned port, seeded so the deal is the same every run. */
async function startServer(seed: number): Promise<Harness> {
  const httpServer = createServer();
  const io = createSocketServer(
    httpServer,
    new RoomManager({
      rng: mulberry32(seed),
      newRoomRng: () => mulberry32(seed + 1),
    }),
  );

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  const clients: ClientSocket[] = [];

  return {
    connect: () =>
      new Promise((resolve) => {
        const client = connectClient(`http://localhost:${port}`, {
          transports: ["websocket"],
        });
        clients.push(client);
        client.on("connect", () => resolve(client));
      }),
    close: async () => {
      for (const client of clients) client.disconnect();
      await io.close();
    },
  };
}

describe("runSession", () => {
  it("creates a room, starts the match, and shows the developer their hand", async () => {
    const server = await startServer(7);
    const printed: string[] = [];

    try {
      const socket = await server.connect();
      await runSession(socket, {
        // Ctrl-D at the first prompt: enough to prove the whole setup flow ran.
        ask: async () => null,
        output: (text) => printed.push(text),
      });
    } finally {
      await server.close();
    }

    const screen = plain(printed.join("\n"));

    assert.match(screen, /room [A-Z0-9]{4,}/i, "the room code is shown to the developer");
    assert.match(screen, /5:/, "a full five-card hand is numbered for selection");
  });

  it("renders every bot move as its own frame, not one jump back to our turn", async () => {
    const server = await startServer(7);
    const frames: string[] = [];
    /** How many frames had been printed by the time each prompt appeared. */
    const promptedAfter: number[] = [];

    try {
      const socket = await server.connect();

      // Track the position from the same broadcasts the session sees, so the scripted
      // "developer" plays legal moves without reaching into the session.
      let view: PlayerGameView | null = null;
      socket.on("gameStateUpdate", (v) => {
        view = v;
      });

      await runSession(socket, {
        ask: async () => {
          promptedAfter.push(frames.length);
          if (promptedAfter.length > 2) return null;
          // Any single card is a legal discard; the last is the highest.
          return String(view!.you.hand.length);
        },
        output: (text) => frames.push(text),
      });
    } finally {
      await server.close();
    }

    assert.equal(promptedAfter.length, 3, "we should get the turn back twice");

    // startGame fills the table to six, so five bots move between our turns. One
    // broadcast for our own move plus one per bot: a single collapsed update would
    // show up here as 1.
    const betweenTurns = promptedAfter[1]! - promptedAfter[0]!;
    assert.ok(
      betweenTurns >= 6,
      `expected a frame per move between our turns, got ${betweenTurns}`,
    );
  });

  it("prints a refused action's error code and leaves the turn with us", async () => {
    const server = await startServer(7);
    const printed: string[] = [];
    let prompts = 0;
    let openingHandValue = 0;

    try {
      const socket = await server.connect();
      socket.on("gameStateUpdate", (view) => {
        if (openingHandValue === 0) openingHandValue = handValue(view.you.hand);
      });

      await runSession(socket, {
        ask: async () => {
          prompts += 1;
          // A five-card opening hand is far over the threshold, so the server must
          // refuse this — the harness has to survive being told no.
          return prompts === 1 ? "yaniv" : null;
        },
        output: (text) => printed.push(text),
      });
    } finally {
      await server.close();
    }

    assert.ok(
      openingHandValue > YANIV_THRESHOLD,
      `fixture assumes an uncallable opening hand, got ${openingHandValue}`,
    );
    assert.match(plain(printed.join("\n")), /YANIV_THRESHOLD_NOT_MET/);
    assert.equal(prompts, 2, "the turn is still ours, so we are asked again");
  });

  it("waits for the position to move on before prompting again", async () => {
    // The server acks an action *before* it broadcasts the result, so for a moment the
    // last view still says it is our turn. Prompting off that stale position asks the
    // developer to play a hand they no longer hold — and the server rightly refuses it.
    const server = await startServer(7);
    const printed: string[] = [];
    /** What the position looked like at each prompt. */
    const seenAtPrompt: string[] = [];
    let view: PlayerGameView | null = null;

    try {
      const socket = await server.connect();
      socket.on("gameStateUpdate", (v) => {
        view = v;
      });

      await runSession(socket, {
        ask: async () => {
          const current = view!;
          seenAtPrompt.push(
            `${current.drawPileCount}|${current.you.hand.map((c) => c.id).join(",")}`,
          );
          if (seenAtPrompt.length > 3) return null;
          return String(current.you.hand.length);
        },
        output: (text) => printed.push(text),
      });
    } finally {
      await server.close();
    }

    // Every turn discards and draws, so a fresh prompt must always be looking at a
    // hand it has not been offered before. A repeat means we prompted twice off one
    // position — the second of those asks for cards that have already been played.
    assert.equal(
      new Set(seenAtPrompt).size,
      seenAtPrompt.length,
      `each prompt should see a new position, got ${JSON.stringify(seenAtPrompt)}`,
    );
    assert.doesNotMatch(
      plain(printed.join("\n")),
      /✗/,
      "a developer playing legal moves should never be refused",
    );
  });

  it("plays a full match through to a winner", async () => {
    const server = await startServer(7);
    const printed: string[] = [];
    /** A cap, so a wedged loop fails the test instead of hanging the suite. */
    const GUARD = 2000;
    let view: PlayerGameView | null = null;
    let prompts = 0;

    try {
      const socket = await server.connect();
      socket.on("gameStateUpdate", (v) => {
        view = v;
      });

      await runSession(socket, {
        // A developer who always sheds their highest card and draws from the deck.
        // Never good enough to call Yaniv — the bots end the rounds, and someone
        // eventually busts past the score limit, which is what ends the match.
        ask: async () => {
          prompts += 1;
          if (prompts > GUARD) return null;
          const current = view!;
          return current.phase === "roundEnd" ? "" : String(current.you.hand.length);
        },
        output: (text) => printed.push(text),
      });
    } finally {
      await server.close();
    }

    assert.ok(prompts <= GUARD, "the match should finish on its own, not hit the guard");
    assert.equal(view!.phase, "gameEnd", "the session returns once the match is over");
    assert.ok(view!.roundNumber > 1, "a full match runs several rounds");

    const screen = plain(printed.join("\n"));
    assert.match(screen, /Match over/);
    assert.match(screen, /← winner/);
    assert.doesNotMatch(
      screen,
      /✗/,
      "every move scripted here is legal, so nothing should have been refused",
    );
  });
});
