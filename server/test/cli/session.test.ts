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

  /**
   * Leaving a lobby without dropping the connection. Both sides are real sessions
   * against one real server, and what each player is told is read off their own screen.
   */
  describe("exiting a lobby to the main menu", () => {
    /** The most recent frame that lists a room and who is sitting in it. */
    const lastRoster = (screen: string[]) =>
      [...screen].map(plain).reverse().find((frame) => /room \w{4}/.test(frame));

    it("frees a guest's seat and leaves the lobby startable by the host", async () => {
      const server = await startServer(7);
      const hostScreen: string[] = [];
      const guestScreen: string[] = [];
      let guestPrompts = 0;

      try {
        const hostSocket = await server.connect();
        let hostPrompts = 0;
        const hostSession = runSession(
          hostSocket,
          {
            ask: async () => {
              hostPrompts += 1;
              if (hostPrompts > 1) return null;
              // Hold the lobby open across Grace's whole visit: she arrives, then
              // leaves again, and only then does the host start the match. Her arrival
              // is read off the whole screen rather than the latest roster, since she
              // may well have left again before this is next looked at.
              await waitUntil("Grace to turn up", () =>
                plain(hostScreen.join("\n")).includes("Grace"),
              );
              await waitUntil("Grace's seat to be freed", () => {
                const roster = lastRoster(hostScreen) ?? "";
                return roster.includes("Ada") && !roster.includes("Grace");
              });
              return "start";
            },
            output: (text) => hostScreen.push(text),
          },
          { playerName: "Ada", entry: { kind: "create" } },
        );

        const roomCode = await readRoomCode(hostScreen);

        const guestSocket = await server.connect();
        const guestSession = runSession(
          guestSocket,
          {
            ask: async () => {
              guestPrompts += 1;
              // Leave the lobby, and then the harness itself — two separate actions,
              // which is the whole point of `menu` existing alongside `q`.
              if (guestPrompts === 1) return "menu";
              return "quit";
            },
            output: (text) => guestScreen.push(text),
          },
          { playerName: "Grace", entry: { kind: "join", roomCode } },
        );

        await Promise.all([hostSession, guestSession]);
      } finally {
        await server.close();
      }

      const host = hostScreen.map(plain);
      assert.ok(
        host.some((frame) => /Grace left/.test(frame)),
        "the host is told the moment someone leaves",
      );
      assert.match(
        host.join("\n"),
        /1:/,
        "the lobby is still the host's to start once Grace has gone",
      );
      assert.doesNotMatch(
        host.join("\n"),
        /✗/,
        "nothing the host did was refused",
      );

      assert.equal(guestPrompts, 2, "the guest lands at a menu rather than the session ending");
      const guest = guestScreen.map(plain);
      assert.ok(
        guest.some((frame) => /join <code>/.test(frame)),
        "and that menu is the main menu",
      );
    });

    // Timed out rather than left to `waitUntil`'s guard: the guest below sits at a
    // prompt that stays unanswered until they are booted, so a session that never gets
    // them back to the menu would hang the suite instead of failing it.
    it("closes the lobby for everyone when the host is the one who leaves", { timeout: 10_000 }, async () => {
      const server = await startServer(7);
      const hostScreen: string[] = [];
      const guestScreen: string[] = [];
      let guestPrompts = 0;

      try {
        const hostSocket = await server.connect();
        let hostPrompts = 0;
        const hostSession = runSession(
          hostSocket,
          {
            ask: async () => {
              hostPrompts += 1;
              if (hostPrompts > 1) return "quit";
              await waitUntil("Grace to be seated", () =>
                (lastRoster(hostScreen) ?? "").includes("Grace"),
              );
              return "menu";
            },
            output: (text) => hostScreen.push(text),
          },
          { playerName: "Ada", entry: { kind: "create" } },
        );

        const roomCode = await readRoomCode(hostScreen);

        const guestSocket = await server.connect();
        const guestSession = runSession(
          guestSocket,
          {
            /**
             * A terminal, not a script: a prompt is answered when the person in front
             * of it types something, which here is only once they have been told the
             * lobby is gone. Being booted therefore has to reach them at the prompt
             * rather than waiting on a keystroke that is not coming.
             */
            ask: async () => {
              guestPrompts += 1;
              if (guestPrompts > 1) return null;
              await waitUntil("Grace to be told the room closed", () =>
                plain(guestScreen.join("\n")).includes("room closed"),
              );
              // Whatever they type next goes to the menu they were dropped at — and
              // opens a room on the same connection, which a socket still bound to the
              // old one could not do.
              return "create";
            },
            output: (text) => guestScreen.push(text),
          },
          { playerName: "Grace", entry: { kind: "join", roomCode } },
        );

        await Promise.all([hostSession, guestSession]);
      } finally {
        await server.close();
      }

      const guest = guestScreen.map(plain);
      assert.ok(
        guest.some((frame) => /host left/i.test(frame)),
        "the guest is told why the lobby went away",
      );
      assert.doesNotMatch(guest.join("\n"), /ALREADY_IN_ROOM/);
      // Two prompts, not three: the one they were already sitting in front of was
      // carried over to the menu. A second prompt issued alongside it would take the
      // line they type and leave the menu still waiting.
      assert.equal(guestPrompts, 2, "the abandoned prompt is not left to swallow a line");

      const codes = [...new Set(guest.join("\n").match(/room ([A-Z0-9]{4})\b/g) ?? [])];
      assert.equal(codes.length, 2, `a second room opened on the same socket, saw ${codes}`);
    });
  });

  /**
   * The finished-match screen: the host's replay, and either player's way out of it.
   *
   * Every test here plays a real match to its end first — there is no shortcut, since
   * `gameEnd` is reached by someone busting past the score limit and nothing else.
   */
  describe("a finished match", () => {
    /**
     * A scripted human who plays a match out and hands the prompt over once it is done.
     *
     * Until then: shed the highest card when it is our turn, deal the next round if we
     * are the host, and otherwise wait — which is what a person in front of a terminal
     * does while somebody else is thinking. Waiting inside the prompt is deliberate: the
     * session reads a typed line against the newest position, so a line decided on a
     * position that has since moved would be answering the wrong screen.
     */
    function playingTo(
      latest: () => PlayerGameView | null,
      atGameEnd: () => Promise<string | null>,
    ): Ask {
      /** Is this seat's move, rather than one it is waiting on somebody else for? */
      const ours = (view: PlayerGameView) => {
        const host = view.hostId === view.you.id;
        if (view.phase === "lobby") return host && view.opponents.length > 0;
        if (view.phase === "playing") return view.currentTurnPlayerId === view.you.id;
        // Only the host deals the next round; everyone else waits for them to.
        if (view.phase === "roundEnd") return host;
        return true;
      };

      return async () => {
        await waitUntil("something for this player to do", () => {
          const view = latest();
          return view !== null && ours(view);
        });

        const view = latest()!;
        if (view.phase === "lobby") return "start";
        if (view.phase === "roundEnd") return "";
        if (view.phase === "gameEnd") return atGameEnd();
        return String(view.you.hand.length);
      };
    }

    /**
     * Two humans and four bots, played through to a winner. Each side's `atGameEnd` is
     * handed its own screen, since what a player does at the standings is mostly a
     * reaction to what the other one has already done there.
     */
    async function twoHumanMatch(
      server: Harness,
      screens: { host: string[]; guest: string[] },
      atGameEnd: {
        host: (screen: string[]) => Promise<string | null>;
        guest: (screen: string[]) => Promise<string | null>;
      },
    ): Promise<void> {
      const { host, guest } = screens;
      let hostView: PlayerGameView | null = null;
      let guestView: PlayerGameView | null = null;

      const hostSocket = await server.connect();
      hostSocket.on("gameStateUpdate", (v) => {
        hostView = v;
      });
      const hostSession = runSession(
        hostSocket,
        {
          ask: playingTo(() => hostView, () => atGameEnd.host(host)),
          output: (text) => host.push(text),
        },
        { playerName: "Ada", entry: { kind: "create" } },
      );

      const roomCode = await readRoomCode(host);

      const guestSocket = await server.connect();
      guestSocket.on("gameStateUpdate", (v) => {
        guestView = v;
      });
      const guestSession = runSession(
        guestSocket,
        {
          ask: playingTo(() => guestView, () => atGameEnd.guest(guest)),
          output: (text) => guest.push(text),
        },
        { playerName: "Grace", entry: { kind: "join", roomCode } },
      );

      await Promise.all([hostSession, guestSession]);
    }

    it("deals another match on the same table when the host asks again", async () => {
      const server = await startServer(7);
      const printed: string[] = [];
      const GUARD = 2000;
      let view: PlayerGameView | null = null;
      let prompts = 0;
      let replayed = false;
      /** The first position of the new match, captured where the developer sees it. */
      let restarted: PlayerGameView | null = null;

      try {
        const socket = await server.connect();
        socket.on("gameStateUpdate", (v) => {
          view = v;
        });

        await runSession(
          socket,
          {
            ask: hostAsk(async () => {
              prompts += 1;
              if (prompts > GUARD) return null;
              const current = view!;
              if (current.phase === "gameEnd") {
                if (replayed) return null;
                replayed = true;
                return "again";
              }
              // The next prompt after the replay is the new match asking for a move:
              // enough to see it dealt, and where this developer stops.
              if (replayed) {
                restarted ??= current;
                return null;
              }
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
      assert.ok(replayed, "the fixture should have reached a finished match");

      const fresh = restarted!;
      assert.equal(fresh.phase, "playing", "the new match is dealt, with no stop at a lobby");
      assert.equal(fresh.roundNumber, 1, "and it is a new match, not another round");
      assert.equal(fresh.you.hand.length, 5, "with a fresh hand");
      for (const player of [fresh.you, ...fresh.opponents]) {
        assert.equal(player.score, 0, `${player.name} starts the new match on nothing`);
      }

      const screen = plain(printed.join("\n"));
      assert.match(screen, /Match over/, "the standings were on screen to reply to");
      assert.doesNotMatch(screen, /✗/, "nothing scripted here should have been refused");
    });

    it("turns a guest's replay down, and lets them leave the host to it", async () => {
      const server = await startServer(7);
      const screens = { host: [] as string[], guest: [] as string[] };

      try {
        let guestTurns = 0;
        await twoHumanMatch(server, screens, {
          // The host sits at the standings until Grace has gone, then quits.
          host: async (screen) => {
            await waitUntil("Grace's seat to be freed", () =>
              plain(screen.join("\n")).includes("Grace left"),
            );
            return null;
          },
          guest: async () => {
            guestTurns += 1;
            // Replaying is the host's alone — the server says so, not the harness.
            if (guestTurns === 1) return "again";
            if (guestTurns === 2) return "menu";
            return "quit";
          },
        });
      } finally {
        await server.close();
      }

      const guest = plain(screens.guest.join("\n"));
      assert.match(guest, /NOT_HOST/, "a guest is told whose call a replay is");
      assert.match(guest, /join <code>/, "and lands back at the main menu when they leave");

      const frames = screens.host.map(plain).filter((f) => /Match over/.test(f));
      assert.ok(frames.length > 1, "the host is still looking at the finished match");
      assert.match(
        frames.at(-1)!,
        /Grace \(left\)/,
        "with the departed seat still named in the standings",
      );
    });

    it("closes a finished match for everyone when the host leaves it", async () => {
      const server = await startServer(7);
      const screens = { host: [] as string[], guest: [] as string[] };

      try {
        let hostTurns = 0;
        await twoHumanMatch(server, screens, {
          host: async () => {
            hostTurns += 1;
            return hostTurns === 1 ? "menu" : "quit";
          },
          // Sitting at the standings with nothing to type: the close has to reach them
          // there, and the prompt they were at carries over to the menu it drops them on.
          guest: async (screen) => {
            await waitUntil("Grace to be told the room closed", () =>
              plain(screen.join("\n")).includes("room closed"),
            );
            return "quit";
          },
        });
      } finally {
        await server.close();
      }

      const guest = plain(screens.guest.join("\n"));
      assert.match(guest, /host left/i, "the same reason the lobby gives, from this screen");
      assert.match(guest, /join <code>/, "and the same main menu to land on");
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
            // A finished match no longer ends the session on its own — the standings
            // are a screen with its own options — so this developer quits from it.
            if (current.phase === "gameEnd") return null;
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
    assert.equal(view!.phase, "gameEnd", "the match is played out to its end");
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
