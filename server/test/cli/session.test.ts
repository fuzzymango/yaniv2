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

type Ask = (prompt: string) => Promise<string | null>;

/**
 * A host's script, with the go-ahead prepended.
 *
 * The harness waits in the lobby rather than starting the moment it has a room, so
 * every host now types `start` before anything else. Wrapping it keeps each test's own
 * script — and its prompt counting — about the match it is there to exercise.
 */
function hostAsk(script: Ask): Ask {
  let started = false;
  return (prompt) => {
    if (started) return script(prompt);
    started = true;
    return Promise.resolve("start");
  };
}

/** Poll until `ready`, so a wedged expectation fails the test instead of hanging it. */
async function waitUntil(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The room code as it appears on screen. That printed line is the whole of the sharing
 * story: the host reads it aloud and another player types it in, so a test that learned
 * the code any other way would not be proving the flow works.
 */
async function readRoomCode(screen: string[]): Promise<string> {
  let found: RegExpMatchArray | null = null;
  await waitUntil("the room code to be printed", () => {
    found = plain(screen.join("\n")).match(/room ([A-Z0-9]{4})/);
    return found !== null;
  });
  return found![1]!;
}

describe("runSession", () => {
  it("creates a room, starts the match, and shows the developer their hand", async () => {
    const server = await startServer(7);
    const printed: string[] = [];

    try {
      const socket = await server.connect();
      await runSession(
        socket,
        {
          // Ctrl-D at the first prompt after the start: enough to prove the whole setup
          // flow ran, including a host starting with nobody else having joined.
          ask: hostAsk(async () => null),
          output: (text) => printed.push(text),
        },
        { playerName: "Ada", entry: { kind: "create" } },
      );
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

      await runSession(
        socket,
        {
          ask: hostAsk(async () => {
            promptedAfter.push(frames.length);
            if (promptedAfter.length > 2) return null;
            // Any single card is a legal discard; the last is the highest.
            return String(view!.you.hand.length);
          }),
          output: (text) => frames.push(text),
        },
        { playerName: "Ada", entry: { kind: "create" } },
      );
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

      await runSession(
        socket,
        {
          ask: hostAsk(async () => {
            prompts += 1;
            // A five-card opening hand is far over the threshold, so the server must
            // refuse this — the harness has to survive being told no.
            return prompts === 1 ? "yaniv" : null;
          }),
          output: (text) => printed.push(text),
        },
        { playerName: "Ada", entry: { kind: "create" } },
      );
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

      await runSession(
        socket,
        {
          ask: hostAsk(async () => {
            const current = view!;
            seenAtPrompt.push(
              `${current.drawPileCount}|${current.you.hand.map((c) => c.id).join(",")}`,
            );
            if (seenAtPrompt.length > 3) return null;
            return String(current.you.hand.length);
          }),
          output: (text) => printed.push(text),
        },
        { playerName: "Ada", entry: { kind: "create" } },
      );
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

  /**
   * Two terminals, one table. Both sides are real sessions against one real server, and
   * every fact is read off the screen the player in front of it would have been looking
   * at — the roster, the log line, the refusal, the deal.
   */
  it("seats a second player who joins by code, and waits for the host to start", async () => {
    const server = await startServer(7);
    const hostScreen: string[] = [];
    const guestScreen: string[] = [];
    let guestView: PlayerGameView | null = null;

    try {
      const hostSocket = await server.connect();
      let hostPrompts = 0;
      const hostSession = runSession(
        hostSocket,
        {
          ask: async () => {
            hostPrompts += 1;
            if (hostPrompts > 1) return null;
            // The host holds the lobby open until the guest has arrived — and has been
            // turned away from starting it themselves.
            await waitUntil("Grace to be refused a start", () =>
              plain(guestScreen.join("\n")).includes("NOT_HOST"),
            );
            return "start";
          },
          output: (text) => hostScreen.push(text),
        },
        { playerName: "Ada", entry: { kind: "create" } },
      );

      const roomCode = await readRoomCode(hostScreen);

      const guestSocket = await server.connect();
      guestSocket.on("gameStateUpdate", (v) => {
        guestView = v;
      });
      let guestPrompts = 0;
      const guestSession = runSession(
        guestSocket,
        {
          ask: async () => {
            guestPrompts += 1;
            // Only the host may begin: the server, not the harness, says so.
            if (guestPrompts === 1) return "start";
            await waitUntil("the match to be dealt", () => guestView?.phase === "playing");
            return null;
          },
          output: (text) => guestScreen.push(text),
        },
        // Typed the way it was heard, not the way it was generated.
        { playerName: "Grace", entry: { kind: "join", roomCode: roomCode.toLowerCase() } },
      );

      await Promise.all([hostSession, guestSession]);
    } finally {
      await server.close();
    }

    const host = hostScreen.map(plain);
    const guest = guestScreen.map(plain);
    /** A lobby frame is the one that lists the room alongside who is sitting in it. */
    const roster = (screen: string[], ...names: string[]) =>
      screen.some((frame) => names.every((n) => frame.includes(n)) && /room \w{4}/.test(frame));

    assert.ok(
      host.some((frame) => /Grace joined/.test(frame)),
      "the host is told the moment someone arrives",
    );
    assert.ok(roster(host, "Ada", "Grace"), "the host's roster grows to include Grace");
    assert.ok(roster(guest, "Ada", "Grace"), "and the guest sees the same table");
    assert.ok(
      guest.some((frame) => /waiting for the host/i.test(frame)),
      "a guest is told the ball is not in their court",
    );
    assert.ok(
      guest.some((frame) => /NOT_HOST/.test(frame)),
      "a guest who tries to start anyway is told why they cannot",
    );
    // Both sides see the match begin, each holding cards only they can see.
    assert.match(guest.join("\n"), /1:/, "the guest is dealt a hand of their own");
    assert.match(host.join("\n"), /1:/, "and so is the host");
    assert.doesNotMatch(
      host.join("\n"),
      /NOT_HOST/,
      "the host's own start is not refused",
    );
  });

  it("says why a join failed rather than sitting at a prompt", async () => {
    const server = await startServer(7);
    const printed: string[] = [];
    let prompts = 0;

    try {
      const socket = await server.connect();
      await runSession(
        socket,
        {
          ask: async () => {
            prompts += 1;
            return null;
          },
          output: (text) => printed.push(text),
        },
        // Nothing has been created on this server, so no code can resolve.
        { playerName: "Grace", entry: { kind: "join", roomCode: "ZZZZ" } },
      );
    } finally {
      await server.close();
    }

    assert.match(plain(printed.join("\n")), /ROOM_NOT_FOUND/);
    assert.equal(prompts, 0, "there is no table to sit at, so nothing is asked for");
  });

  /**
   * Omitting `entry` is what a bare `--name` now means: the interactive main menu,
   * rather than the old implicit "create a room". `--join`/`--create` bypass it
   * entirely — those paths are covered by the tests above, which all pass `entry`.
   */
  describe("the interactive main menu", () => {
    it("is shown by default, and 'create' opens a room from it", async () => {
      const server = await startServer(7);
      const printed: string[] = [];
      let prompts = 0;

      try {
        const socket = await server.connect();
        await runSession(
          socket,
          {
            ask: async () => {
              prompts += 1;
              if (prompts === 1) return "create";
              if (prompts === 2) return "start";
              return null;
            },
            output: (text) => printed.push(text),
          },
          { playerName: "Ada" },
        );
      } finally {
        await server.close();
      }

      const screen = plain(printed.join("\n"));
      assert.match(screen, /create/, "the menu is shown before any room exists");
      assert.match(screen, /room [A-Z0-9]{4,}/i, "'create' opens a room, same as --create");
    });

    it("joins a room by typing its code, exactly as --join would", async () => {
      const server = await startServer(7);
      const hostScreen: string[] = [];
      const guestScreen: string[] = [];

      try {
        const hostSocket = await server.connect();
        let hostPrompts = 0;
        const hostSession = runSession(
          hostSocket,
          {
            ask: async () => {
              hostPrompts += 1;
              if (hostPrompts > 1) return null;
              await waitUntil("Grace to join from the menu", () =>
                plain(guestScreen.join("\n")).includes("Grace"),
              );
              return "start";
            },
            output: (text) => hostScreen.push(text),
          },
          { playerName: "Ada", entry: { kind: "create" } },
        );

        const roomCode = await readRoomCode(hostScreen);

        const guestSocket = await server.connect();
        let guestPrompts = 0;
        const guestSession = runSession(
          guestSocket,
          {
            ask: async () => {
              guestPrompts += 1;
              // Typed the way it was heard, not the way it was generated.
              if (guestPrompts === 1) return `join ${roomCode.toLowerCase()}`;
              return null;
            },
            output: (text) => guestScreen.push(text),
          },
          { playerName: "Grace" },
        );

        await Promise.all([hostSession, guestSession]);
      } finally {
        await server.close();
      }

      const guest = guestScreen.map(plain);
      assert.ok(
        guest.some((frame) => /room \w{4}/i.test(frame)),
        "'join <code>' at the menu seats the guest at the host's table",
      );
    });

    it("quits without ever creating or joining a room", async () => {
      const server = await startServer(7);
      const printed: string[] = [];
      let prompts = 0;

      try {
        const socket = await server.connect();
        await runSession(
          socket,
          {
            ask: async () => {
              prompts += 1;
              return "quit";
            },
            output: (text) => printed.push(text),
          },
          { playerName: "Ada" },
        );
      } finally {
        await server.close();
      }

      assert.equal(prompts, 1, "quitting from the menu is immediate");
      assert.doesNotMatch(
        plain(printed.join("\n")),
        /room [A-Z0-9]{4,}/i,
        "no room was ever created or joined",
      );
    });

    it("shows a bad code's error and returns to the menu, rather than ending the session", async () => {
      const server = await startServer(7);
      const printed: string[] = [];
      let prompts = 0;

      try {
        const socket = await server.connect();
        await runSession(
          socket,
          {
            ask: async () => {
              prompts += 1;
              if (prompts === 1) return "join ZZZZ";
              if (prompts === 2) return "quit";
              return null;
            },
            output: (text) => printed.push(text),
          },
          // Nothing has been created on this server, so no code can resolve — unlike
          // the flag-based version of this failure above, this one was typed at a menu
          // the session can fall back to.
          { playerName: "Grace" },
        );
      } finally {
        await server.close();
      }

      const screen = plain(printed.join("\n"));
      assert.match(screen, /ROOM_NOT_FOUND/, "the existing error is shown");
      assert.equal(
        prompts,
        2,
        "the menu is offered again rather than the session ending",
      );
    });

    it("survives nonsense typed at the menu instead of crashing", async () => {
      const server = await startServer(7);
      const printed: string[] = [];
      let prompts = 0;

      try {
        const socket = await server.connect();
        await runSession(
          socket,
          {
            ask: async () => {
              prompts += 1;
              if (prompts === 1) return "banana";
              if (prompts === 2) return "quit";
              return null;
            },
            output: (text) => printed.push(text),
          },
          { playerName: "Grace" },
        );
      } finally {
        await server.close();
      }

      assert.match(plain(printed.join("\n")), /didn't understand/i);
      assert.equal(
        prompts,
        2,
        "the menu reprompts rather than crashing or ending the session",
      );
    });
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

      await runSession(
        socket,
        {
          // A developer who always sheds their highest card and draws from the deck.
          // Never good enough to call Yaniv — the bots end the rounds, and someone
          // eventually busts past the score limit, which is what ends the match.
          ask: hostAsk(async () => {
            prompts += 1;
            if (prompts > GUARD) return null;
            const current = view!;
            return current.phase === "roundEnd" ? "" : String(current.you.hand.length);
          }),
          output: (text) => printed.push(text),
        },
        { playerName: "Ada", entry: { kind: "create" } },
      );
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
