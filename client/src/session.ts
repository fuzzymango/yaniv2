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
import type { DrawSource } from "./turn.ts";
import { isLegalCall, retainSelection, toggleSelection, turnFrom } from "./turn.ts";

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
  /**
   * The cards chosen for the next turn, by id, **in tap order** — the order decides where
   * a joker extending a run sits (docs/rules.md §4), so it is the move and not merely a
   * way of writing it down. See "Selection" in CONTEXT.md.
   *
   * It lives here rather than in a component because it has to survive views arriving
   * underneath it: a card that leaves the hand leaves the selection with it, and that is
   * a rule about incoming server state, which is what this module is for.
   */
  readonly selection: readonly string[];
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
  /** Choose a card for the next turn, or un-choose one already chosen. */
  toggleCard: (cardId: string) => void;
  /**
   * Play the selection, drawing from where the player tapped. One action, because the
   * engine has no state between discarding and drawing (see "Turn model" in CLAUDE.md).
   *
   * A tap the rules do not permit sends nothing and says nothing: the interface should
   * not have offered it, and a player who taps a dead target has asked for nothing and
   * been refused nothing.
   */
  commitTurn: (source: DrawSource) => void;
  /**
   * End the round on a hand worth the threshold or less (docs/rules.md §6). It replaces a
   * turn rather than being part of one, which is why it is its own intent and takes no
   * selection.
   *
   * A call the rules do not permit sends nothing and says nothing, exactly as a turn does:
   * the control should have been inert, and a player who tapped a dead one has asked for
   * nothing.
   */
  callYaniv: () => void;
  /**
   * Deal the next round from a scored one. Host only — and, as with `startGame`, the
   * server is what says so, answering anyone else with `NOT_HOST`.
   */
  startNextRound: () => void;
  /**
   * Deal another match to the same table from a finished one — scores back to zero and the
   * first round dealt on the spot, with no stop in the lobby. Host only, and the server
   * says so.
   *
   * A seat given up since the match ended stays given up: nothing refills it, and a table
   * that has shrunk below two is refused with `NOT_ENOUGH_PLAYERS` rather than quietly
   * seated with bots. That is the server's rule and the client does not anticipate it —
   * unlike a discard, there is no rulebook here for a client to read.
   */
  playAgain: () => void;
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
  let snapshot: SessionSnapshot = {
    view: null,
    error: null,
    notice: null,
    busy: false,
    selection: [],
  };
  const listeners = new Set<() => void>();

  const publish = (next: Partial<SessionSnapshot>): void => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  /**
   * How many positions have arrived, and which one a turn is waiting to be played past.
   *
   * The counter is the CLI's `Position { view, version }` and `actedOn` watermark, kept
   * here rather than in a component because it is the same fact about the same wire: the
   * server acks a turn *before* it broadcasts the result, so for a moment after a move
   * the last view still shows the mover's own turn and their discarded cards in hand.
   * Controls released on the ack would come back to life over that stale position.
   *
   * *Any* newer position releases it, not only the one the turn caused — which is the
   * same thing wherever it matters, since nobody else can move while the turn is ours.
   * Off turn it lets go a beat early, on a broadcast from whoever is actually playing;
   * the turn being sent again from there is refused either way.
   */
  let version = 0;
  let committedAt: number | null = null;

  /**
   * Every broadcast is published the moment it lands. A run of bot turns arrives as one
   * update per move, so a screen that renders on arrival shows the moves as moves — the
   * pacing that makes them watchable belongs here too, but it is not needed until there
   * is a table to watch.
   *
   * A committed turn's lock is released here and only here, on a strictly newer position
   * than the one it was played from. That same filtering of the selection against the
   * arriving hand is what empties it afterwards: the cards it named have just been
   * discarded, so nothing survives the move that made them.
   *
   * A position with no move to make from it takes the selection with it, rather than
   * filtering it. A round that has been scored is over, and a card id is the same string
   * in every round of a match — the deck is rebuilt, not shuffled on — so a choice carried
   * across a deal would come back chosen over whatever card inherited its id.
   */
  socket.on("gameStateUpdate", (view) => {
    version += 1;
    const played = committedAt !== null && version > committedAt;
    if (played) committedAt = null;

    publish({
      view,
      selection:
        view.phase === "playing"
          ? retainSelection(snapshot.selection, view.you.hand)
          : [],
      busy: played ? false : snapshot.busy,
    });
  });

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
  socket.on("roomClosed", (reason) => {
    // A turn in flight is one nobody will answer now, and a selection is a tap or two
    // made in front of a table that is no longer there. Neither goes to the next room.
    committedAt = null;
    publish({
      view: null,
      notice: `The room closed — ${reason}.`,
      error: null,
      busy: false,
      selection: [],
    });
  });

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
   * How a refusal lands, wherever it comes from.
   *
   * A rejection that arrives after the room has already gone is about a room that no
   * longer exists. It happens when the host closes the room while somebody else's action
   * is in flight: the server has dropped their session, so the ack comes back
   * `PLAYER_NOT_FOUND`. They are already on the menu being told why, and blaming them for
   * it on top would be exactly what a refusal must never cost.
   */
  const refuse = (error: GameError): void => {
    if (snapshot.view === null) publish({ busy: false });
    else settle(error);
  };

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
        refuse(result.error);
        return;
      }
      publish({
        error: null,
        busy: false,
        view: leavesRoom ? null : snapshot.view,
        selection: leavesRoom ? [] : snapshot.selection,
      });
    });
  };

  /**
   * How a move goes out — a turn, or a call that replaces one.
   *
   * Unlike `act`, the lock is not released by the ack: the server acks a move before it
   * broadcasts the position it produced, so the controls would come back to life over a
   * table that still shows the move as unplayed. The watermark is taken before the emit,
   * so the ack cannot be mistaken for the position being waited on.
   *
   * A refusal is the exception and lets go at once. Nothing was published, so no newer
   * position is coming — and the move is still theirs to make.
   *
   * Unlike `act` it takes no `busy` guard of its own: each caller has already turned back
   * for reasons of its own — a locked screen, no room, a move the rules do not permit —
   * before there is a move worth sending.
   */
  const play = (emit: (ack: Ack<null>) => void): void => {
    committedAt = version;
    publish({ error: null, busy: true });

    emit((result) => {
      if (result.ok) return;
      committedAt = null;
      refuse(result.error);
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

    // Choosing costs nothing and asks for nothing, so there is no error to clear and no
    // lock to take — only the one already held by a turn on its way out.
    toggleCard: (cardId) => {
      if (snapshot.busy) return;
      publish({ selection: toggleSelection(snapshot.selection, cardId) });
    },

    commitTurn: (source) => {
      if (snapshot.busy || snapshot.view === null) return;

      /*
       * The rulebook has the last word on what may be sent, and it is the same rulebook
       * the server will judge the move by. Nothing to say when it refuses: the screen
       * should not have offered a tap that lands here, and a player who found a dead
       * target has asked for nothing.
       */
      const action = turnFrom(snapshot.selection, snapshot.view, source);
      if (action === null) return;

      play((ack) => socket.emit("takeTurn", action, ack));
    },

    callYaniv: () => {
      if (snapshot.busy || snapshot.view === null) return;

      // The same rulebook the server will judge the call by, and the same silence when it
      // says no: an inert control that was tapped anyway has asked for nothing. Whether it
      // is this player's turn is left to the server, exactly as it is for a discard.
      if (!isLegalCall(snapshot.view.you.hand)) return;

      play((ack) => socket.emit("callYaniv", ack));
    },

    // Ack-settled, like `startGame` and for the same reason: dealing is answered by the
    // ack itself rather than by a move landing in a position already on the screen. The
    // lock still holds across the round trip, which is what a double tap needs it to.
    startNextRound: () => act((ack) => socket.emit("startNextRound", ack)),

    // The same shape, and for the same reason: another match is a position produced rather
    // than a move within one.
    playAgain: () => act((ack) => socket.emit("playAgain", ack)),
  };
}
