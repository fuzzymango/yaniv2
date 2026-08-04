/**
 * The session core: everything between a connected socket and a screen.
 *
 * Framework-free on purpose. It owns the socket, holds the client's whole idea of the
 * game, and exposes exactly two things — a snapshot to read and a set of intents to
 * call. React subscribes to it through `useSyncExternalStore` and holds no logic of its
 * own; see `useSession.ts`.
 *
 * This is the direct analogue of `server/scripts/cli/session.ts`, and the same rule
 * applies: it knows the event contract and nothing else. There is no import from
 * `server/src` here and there must never be one, or the client would stop being a
 * client and become a second copy of the server.
 *
 * The socket is injected rather than opened here, which is what lets a test point the
 * session at a real server on an ephemeral port. Opening one against the page's own
 * origin is the entrypoint's job — see `main.tsx`.
 */

import type {
  ClientToServerEvents,
  GameError,
  PlayerGameView,
  ServerToClientEvents,
} from "@yaniv/shared";
import type { Socket } from "socket.io-client";

/**
 * Declared here rather than imported from the CLI harness, which has the identical
 * line. `shared` would be the obvious home for it, but the type needs
 * `socket.io-client`, and `shared` is dependency-free so that this workspace can import
 * it at all. The contract the two sides agree on — the events — does live there.
 */
export type YanivClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * What a screen renders from. Immutable and replaced wholesale on every change, because
 * `useSyncExternalStore` compares snapshots by identity — a mutated object would leave
 * React showing a position that has already moved on.
 */
export interface SessionSnapshot {
  /**
   * The current position, or null when there is no room to be in. Null *is* the main
   * menu: it is the one screen that is not a function of `view.phase`, because before a
   * room exists there is nothing for the server to have sent. See docs/adr/0004.
   */
  readonly view: PlayerGameView | null;
  /**
   * The last rejection worth showing the player, cleared the moment they try again. A
   * refused action costs them nothing, so this is news rather than a state to recover
   * from.
   */
  readonly error: GameError | null;
  /**
   * An intent is in flight and the controls that sent it are locked. A phone taps twice
   * on a slow connection far more readily than a keyboard does, and the second create
   * would be refused with `ALREADY_IN_ROOM` — an error about the transport, shown to a
   * player who did nothing wrong.
   */
  readonly busy: boolean;
}

export interface Session {
  /** Subscribe to snapshot changes; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => SessionSnapshot;
  createRoom: (playerName: string) => void;
  /** The code as typed. Case is not the player's problem — see below. */
  joinRoom: (roomCode: string, playerName: string) => void;
}

/**
 * Refused here rather than by the server, so the answer is instant and the player is
 * never sent away from the menu and back. The server enforces the same rule — this is
 * the client declining to offer a move it already knows will be refused, not the client
 * deciding a rule of its own.
 */
const EMPTY_NAME: GameError = {
  code: "INVALID_NAME",
  message: "Enter a name before creating or joining a room",
};

export function createSession(socket: YanivClientSocket): Session {
  let snapshot: SessionSnapshot = { view: null, error: null, busy: false };
  const listeners = new Set<() => void>();

  const publish = (next: Partial<SessionSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  /**
   * Every broadcast is published the moment it lands. A run of bot turns arrives as one
   * update per move, so a screen that renders on arrival shows the moves as moves — the
   * pacing that makes them watchable belongs here too, but it is not needed until there
   * is a table to watch.
   */
  socket.on("gameStateUpdate", (view) => publish({ view }));

  /**
   * The name to enter a room under, or null when there is no asking: the controls are
   * already locked on an earlier attempt, or the player has typed nothing.
   *
   * Locking here rather than at each intent is what makes the guard cover both ways in.
   */
  const beginEntry = (playerName: string): string | null => {
    if (snapshot.busy) return null;

    const name = playerName.trim();
    if (name.length === 0) {
      publish({ error: EMPTY_NAME });
      return null;
    }

    publish({ error: null, busy: true });
    return name;
  };

  /**
   * How both ways in end. The lock is released on the ack rather than on an arriving
   * view because entering a room has an answer of its own: a refusal leaves the player
   * where they are, and a success has already been broadcast — the server publishes the
   * lobby before it acks.
   */
  const settle = (error: GameError | null): void => publish({ error, busy: false });

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot: () => snapshot,

    createRoom: (playerName) => {
      const name = beginEntry(playerName);
      if (name === null) return;
      socket.emit("createRoom", name, (result) =>
        settle(result.ok ? null : result.error),
      );
    },

    joinRoom: (roomCode, playerName) => {
      const name = beginEntry(playerName);
      if (name === null) return;
      // Upper-cased on the way out: a code is read aloud and typed back in, and a phone
      // keyboard does not start on capitals. The server matches codes exactly, so this
      // is the client meeting it rather than the player having to.
      socket.emit("joinRoom", roomCode.trim().toUpperCase(), name, (result) =>
        settle(result.ok ? null : result.error),
      );
    },
  };
}
