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
  Ack,
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
   * News about the room that is not a refusal of anything the player did — today, only
   * the host closing it under them. Separate from `error` because there is no action to
   * blame and nothing to retry: it is the last thing they hear about that room, and it
   * arrives while they are sitting still.
   */
  readonly notice: string | null;
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
  /**
   * Deal the first round, filling every empty seat with a bot. Host only — and the
   * server is what says so, answering anyone else with `NOT_HOST`. A screen that shows
   * the control to the host alone is a courtesy, not the rule.
   */
  startGame: () => void;
  /**
   * Leave the room without dropping the connection, and go back to the main menu.
   *
   * What it costs the rest of the table is the server's decision and not the caller's:
   * a guest frees their own seat, the host closes the room. The client is not told
   * which happened, and does not need to be — either way it is out.
   */
  exitToMenu: () => void;
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
  let snapshot: SessionSnapshot = { view: null, error: null, notice: null, busy: false };
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
   * The room is gone and this connection is no longer in it — the host having left is
   * today the only cause. Dropping the view is what returns the player to the main menu,
   * and the reason goes with them so they are not left wondering where the table went.
   *
   * The reason arrives as a fragment — "the host left the room" — so it is made into a
   * sentence here rather than at the screen, because this handler is what knows which
   * kind of news it is. The CLI frames it the same way, and the CLI is the specification
   * for behaviour.
   */
  socket.on("roomClosed", (reason) =>
    publish({
      view: null,
      notice: `The room closed — ${reason}.`,
      error: null,
      busy: false,
    }),
  );

  /*
   * There is deliberately no handler for `playerJoined` or `playerLeft`. The roster
   * arrives right behind each of them as a fresh view, and a screen that re-renders in
   * place shows a seat filling or emptying by itself — the CLI needs those nudges only
   * because its frames scroll away from each other.
   */

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

    // The notice goes with the error: a player who is acting again has read whatever
    // became of the last room, and it has nothing to say about this one.
    publish({ error: null, notice: null, busy: true });
    return name;
  };

  /**
   * How both ways in end. The lock is released on the ack rather than on an arriving
   * view because entering a room has an answer of its own: a refusal leaves the player
   * where they are, and a success has already been broadcast — the server publishes the
   * lobby before it acks.
   */
  const settle = (error: GameError | null): void => publish({ error, busy: false });

  /**
   * How an action inside a room goes out: locked on the way so a double tap sends one
   * of it, and settled by the server's answer.
   *
   * `leavesRoom` is the one thing an ack alone decides. Every other action is confirmed
   * by the broadcast behind it, but leaving is confirmed by nothing — the server has
   * stopped publishing to this connection, so the session has to learn it is out from
   * the ack itself.
   */
  const act = (emit: (ack: Ack<null>) => void, leavesRoom = false): void => {
    if (snapshot.busy) return;
    publish({ error: null, busy: true });
    emit((result) => {
      if (!result.ok) {
        /*
         * A rejection that lands after the room has already gone is about a room that no
         * longer exists. It happens when the host closes the room while somebody else's
         * action is in flight: the server has dropped their session, so the ack comes
         * back `PLAYER_NOT_FOUND`. They are already on the menu being told why, and
         * blaming them for it on top would be exactly what a refusal must never cost.
         */
        if (snapshot.view === null) publish({ busy: false });
        else settle(result.error);
        return;
      }
      publish({
        error: null,
        busy: false,
        view: leavesRoom ? null : snapshot.view,
      });
    });
  };

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

    startGame: () => act((ack) => socket.emit("startGame", ack)),

    // The view goes with the seat: there is no room to render any more, and a null view
    // *is* the main menu.
    exitToMenu: () => act((ack) => socket.emit("exitToMenu", ack), true),
  };
}
