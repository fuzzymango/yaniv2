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
  ResumeRequest,
  RoomSettings,
  ServerToClientEvents,
} from "@yaniv/shared";
import type { Socket } from "socket.io-client";
import type { Clock } from "./pacing.ts";
import { createPacer, systemClock } from "./pacing.ts";
import type { DrawSource } from "./turn.ts";
import {
  isLegalCall,
  isSlapdownTarget,
  retainSelection,
  toggleSelection,
  turnFrom,
} from "./turn.ts";

/**
 * Declared here rather than imported from the CLI harness, which has the identical
 * line. `shared` would be the obvious home for it, but the type needs
 * `socket.io-client`, and `shared` is dependency-free so that this workspace can import
 * it at all. The contract the two sides agree on — the events — does live there.
 */
export type YanivClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Where a seat's credential is kept between one connection and the next.
 *
 * The whole `ResumeRequest` and not merely the token: a seat is named by the room and the
 * player as well, and the three are only ever presented together (see "Resume token" in
 * CONTEXT.md). Storing them as one thing is the same reasoning that makes the socket
 * layer's session one optional object — a half-remembered seat is unrepresentable.
 *
 * Injected rather than reached for, exactly as the socket is: storage is the one global
 * anything below `main.tsx` would otherwise want, and nothing below it is allowed to hold
 * one — which is what keeps this module testable with no browser anywhere in it. The real
 * one is `seatStore` in `tokens.ts`, handed over in `main.tsx`; a session given none simply
 * holds its seat for as long as the page is open.
 */
export interface TokenStore {
  /** The seat to claim back, or null when this page knows of none. */
  get: () => ResumeRequest | null;
  set: (seat: ResumeRequest) => void;
  clear: () => void;
}

/**
 * What a session with nowhere to write things down does: hold the seat in memory and lose
 * it with the page. A live reconnect still claims its seat back; a reload starts over.
 */
const NO_STORE: TokenStore = {
  get: () => null,
  set: () => {},
  clear: () => {},
};

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
   *
   * The room's settings ride here too, as `view.settings`, in every phase — deliberately
   * not lifted out into a field of their own. They arrive with the position and they are
   * only meaningful with one, so a second copy beside it could only ever be the same fact
   * written twice, with a moment between the two writes where a screen could read the old
   * one. `callYaniv` reads the threshold straight off the view for that reason.
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
   * Whether there is a socket to play over. False means every control on the screen is
   * dead, whatever it looks like — which is the whole reason this is a field rather than
   * something left to a socket the components cannot see.
   *
   * It starts true, before the socket has finished connecting: socket.io buffers what is
   * emitted before then and sends it on connect, so a player who is quick off the mark on
   * a fresh page load has not lost anything, and a screen that announced a dropped
   * connection for the first moment of every load would be crying wolf.
   */
  readonly connected: boolean;
  /**
   * A seat is being claimed back and the answer has not landed yet — the page has just
   * opened on a stored credential, or a dropped connection has just returned.
   *
   * Distinct from `busy`, which it always accompanies: `busy` says the controls are
   * locked, this says the position on the screen, or the absence of one, is not yet the
   * answer to anything. A cold boot is the case that needs it — `view` is null and
   * `connected` is true, which on any other page load *is* the main menu, and here is a
   * table the session has every expectation of getting back.
   */
  readonly resuming: boolean;
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
   * Replace the room's settings — how many cards are dealt, what a Yaniv may be called
   * on, what score ends the match, how many bots fill the table (docs/adr/0006).
   *
   * All four at once, never a patch, because that is the shape of the event: a room is
   * never half-way between one host's choices and another's. Host only and lobby only,
   * and the server is what says so — `NOT_HOST` and `WRONG_PHASE` come back as refusals
   * like any other. A screen that offers the controls to the host alone, and only before
   * the deal, is the same courtesy the start control is.
   *
   * Nothing is checked here ahead of the server. `INVALID_SETTINGS` guards against a
   * client that is off the contract, and a typed one cannot construct a `RoomSettings`
   * that would earn it — unlike a discard, where the rulebook can answer before the wire
   * does.
   */
  updateSettings: (settings: RoomSettings) => void;
  /**
   * Deal the first round, filling as many empty seats with bots as the room's settings
   * ask for. Host only — and the server is what says so, answering anyone else with
   * `NOT_HOST`. A screen that shows the control to the host alone is a courtesy, not the
   * rule.
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
  /**
   * End the room for everyone and go back to the main menu. The host's alone, and the
   * server is what says so — anyone else is answered `NOT_HOST` and left where they are.
   *
   * Distinct from `exitToMenu`, which is about a seat: this is about the room, works in
   * every phase, and a mid-round table nobody is playing on any more is exactly the one it
   * exists for. That the host's `exitToMenu` closes the room too is a consequence of the
   * seat they hold, not the same act — there is no phase in which it is offered and this
   * is not, and no phase where the host may leave a room standing.
   *
   * Answered by the ack alone, for `exitToMenu`'s reason: the server stops publishing to a
   * connection it has turned out of a room, so nothing is coming behind it.
   */
  closeRoom: () => void;
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
   * Put the just-drawn card straight back down on the set it matches (docs/rules.md §9).
   * No payload: a player draws one card a turn, so the server already knows which card
   * is meant.
   *
   * The one intent sent while the turn belongs to somebody else, and the one racing them
   * for it: losing comes back as `SLAPDOWN_NOT_AVAILABLE` and costs nothing, exactly as
   * any other refusal does. A tap with no window open sends nothing and says nothing —
   * the pile should not have been offering itself.
   */
  slapDown: () => void;
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

/**
 * What a player is told when the seat they were in cannot be had back: the room has been
 * closed or has gone from the server, or the credential offered for it was refused. News
 * rather than a refusal, the same shape as a room closing under them — they did nothing to
 * cause it and there is nothing to retry.
 *
 * One sentence for both ways of losing a seat, because they are one thing to whoever is
 * reading it: that table is not there to go back to. Which of them it was is a distinction
 * only the server could draw, and it deliberately does not — `INVALID_RESUME_TOKEN` covers
 * a wrong token and an unknown seat alike, so a room code cannot be used to fish for the
 * seats behind it.
 */
const UNAVAILABLE = "That game is no longer available.";

/**
 * A position as it arrived, and how many had arrived when it did.
 *
 * The same pair the CLI keeps, and for the same reason — but the two halves are now used
 * a moment apart: positions are queued on the way in and drawn on a beat (see
 * `pacing.ts`), so "is this newer than the move we sent?" has to be asked of when it
 * *landed*, not of when it reached the screen. A view drawn out of a chain that was
 * already in flight when the move went out is not an answer to it.
 */
interface Position {
  readonly view: PlayerGameView;
  readonly version: number;
}

export function createSession(
  socket: YanivClientSocket,
  clock: Clock = systemClock,
  tokens: TokenStore = NO_STORE,
): Session {
  let snapshot: SessionSnapshot = {
    view: null,
    error: null,
    notice: null,
    busy: false,
    connected: true,
    resuming: false,
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
   * The counter is the CLI's `Position` and `actedOn` watermark, kept here rather than in
   * a component because it is the same fact about the same wire: the
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
   * What is still chosen once a position has arrived. Filtering the selection against the
   * hand in it is also what empties it after a committed turn: the cards it named have
   * just been discarded, so nothing survives the move that made them.
   *
   * A position with no move to make from it takes the selection with it, rather than
   * filtering it. A round that has been scored is over, and a card id is the same string
   * in every round of a match — the deck is rebuilt, not shuffled on — so a choice carried
   * across a deal would come back chosen over whatever card inherited its id.
   *
   * Stated once and here, because a seat claimed back answers it the same way an arriving
   * broadcast does.
   */
  const carriedInto = (view: PlayerGameView): readonly string[] =>
    view.phase === "playing" ? retainSelection(snapshot.selection, view.you.hand) : [];

  /**
   * A position reaching the screen.
   *
   * A committed turn's lock is released here and only here, on a strictly newer position
   * than the one it was played from.
   */
  const show = ({ view, version: arrivedAt }: Position): void => {
    const played = committedAt !== null && arrivedAt > committedAt;
    if (played) committedAt = null;

    publish({
      view,
      selection: carriedInto(view),
      busy: played ? false : snapshot.busy,
    });
  };

  /**
   * The queue between the wire and the screen. A run of bot turns arrives as one update
   * per move with no delay behind it, so drawing each on arrival would show only the last
   * — see `pacing.ts` for why the pacing is the client's job and not the server's.
   */
  const paced = createPacer(show, clock);

  socket.on("gameStateUpdate", (view) => {
    version += 1;
    paced.offer({ view, version });
  });

  /**
   * The seat this session can sit back down in, or null when it holds none.
   *
   * Held here as well as in the store because the two answer different questions: the
   * store is what survives the page, and this is what survives a socket. A session given
   * no store still claims its seat back across a drop — it only starts over on a reload.
   */
  let seat: ResumeRequest | null = tokens.get();

  /** Seated: remember the seat both ways, so a reload and a drop find the same one. */
  const remember = (next: ResumeRequest): void => {
    seat = next;
    tokens.set(next);
  };

  /**
   * Not seated any more. Exactly three things reach here: the player giving the seat up,
   * the room closing under them, and a claim the server refuses. A dropped connection is
   * pointedly not one of them — that is the case the seat is kept *for*.
   */
  const forget = (): void => {
    seat = null;
    tokens.clear();
  };

  /**
   * There is no table any more: back to the main menu, told why if there is anything worth
   * telling. The one way out of a room that the player did not ask for, and every way in
   * to it ends here — a room closed under them, a seat that could not be claimed back, and
   * a connection that came back holding nothing to claim with.
   *
   * A turn in flight is one nobody will answer now, and a selection is a tap or two made in
   * front of a table that is no longer there. Neither goes to the next room — and neither
   * does whatever the chain still had left to show, which would otherwise draw the departed
   * room back over the menu, one beat at a time.
   *
   * `reconnected` rides along rather than being published beside this, because a screen
   * that saw `connected` come back a moment before the view went would draw the dead table
   * as a live one.
   */
  const leaveTable = (notice: string | null, reconnected = false): void => {
    forget();
    paced.reset();
    committedAt = null;
    publish({
      connected: reconnected || snapshot.connected,
      view: null,
      notice,
      error: null,
      busy: false,
      resuming: false,
      selection: [],
    });
  };

  /**
   * Ask for the seat back, now or as soon as there is a socket to ask over.
   *
   * `resuming` goes up before the emit and comes down on the answer, and it is what makes
   * a cold boot legible: until the ack lands, a null view is a table still being asked
   * for rather than the main menu. `busy` rides with it because a seat that is not yet
   * bound is one nothing can be played from — the server would answer `PLAYER_NOT_FOUND`
   * to anything sent in the meantime.
   *
   * Nothing is emitted into a socket that is down. Socket.io would buffer it and send it
   * on connect, but the `connect` handler below sends the claim anyway, and a claim sent
   * twice is answered `ALREADY_IN_ROOM` the second time — a refusal that would look
   * exactly like a seat that had gone.
   *
   * `reconnected` is published in the same breath as `resuming`, for the reason
   * `leaveTable` takes it: the moment between the two would read as the main menu.
   */
  const claimSeat = (reconnected = false): void => {
    const claiming = seat;
    if (claiming === null) return;

    publish({
      connected: reconnected || snapshot.connected,
      resuming: true,
      busy: true,
      error: null,
    });
    if (!socket.connected) return;

    socket.emit("resumeSeat", claiming, (result) => {
      if (!result.ok) {
        leaveTable(UNAVAILABLE);
        return;
      }

      // The position comes back in the ack rather than as a broadcast — it is the answer
      // to this call and to nobody else's — so it is counted in as an arrival like any
      // other, and drawn at once rather than queued: there is no chain behind it.
      version += 1;
      const { view } = result.value;
      // Re-stored rather than merely kept, so a page that came up on a credential leaves
      // with the same one written down as the session is holding.
      remember(claiming);
      publish({
        view,
        selection: carriedInto(view),
        notice: null,
        error: null,
        busy: false,
        resuming: false,
      });
    });
  };

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
    // The seat goes with the room — `leaveTable` forgets it. One of exactly two things
    // that end a seat, the other being the player leaving of their own accord; keeping a
    // credential for a room that has been closed would only earn a refusal on the next
    // page load.
    leaveTable(`The room closed — ${reason}.`);
  });

  /**
   * Whether the drop took a table down with it that this session cannot ask for back —
   * a view arrived, but no credential for the seat behind it.
   *
   * The window is small and real: the server broadcasts the lobby *before* it acks the
   * join that names the seat, so a socket that goes in between leaves a position on the
   * screen and nothing to claim it with. Remembered across the gap so the player can be
   * told what became of it once there is a screen to tell them on; a drop at the main menu
   * costs nothing and is worth saying nothing about.
   */
  let lostARoom = false;

  /**
   * The socket has gone. Every control on the screen is now dead, whatever it looks like
   * — but the table is not: the server holds the seat open, and the connection coming back
   * claims it (see `connect` below).
   *
   * The lock goes, because nothing is in flight over a socket that is not there — the ack
   * a move was waiting on is never arriving, and neither is the position behind it. That
   * includes a claim: one made over a socket that then dropped is answered by nobody, so
   * `resuming` comes down here and the next connection asks again from the top. What is
   * left on the screen is the last position anybody saw, which the disconnected screen
   * covers over rather than clears — there is nothing to replace it with until the socket
   * comes back, and it is very likely the position that is still there when it does.
   */
  socket.on("disconnect", () => {
    lostARoom = snapshot.view !== null && seat === null;
    // Whatever the chain still had left to show belongs to a table nobody is at.
    paced.reset();
    committedAt = null;
    publish({ connected: false, busy: false, resuming: false });
  });

  /**
   * A connection that never arrived, rather than one that went — the server is down, or
   * the page was opened with no signal. The same dead screen from the player's side, so
   * the same answer: say there is no connection instead of buffering their taps into a
   * socket that has never reached anything.
   *
   * It cannot have cost a room, which is why it leaves `lostARoom` alone: a failed attempt
   * has never carried one, and after a drop the flag it must not tread on is already set.
   * Retries fire this once each, and only the first is news.
   *
   * A claim comes down with it exactly as it does on a drop — a page that came up on a
   * stored seat and found no server has asked nobody anything, and leaving `resuming` up
   * would be a claim in flight over a socket that has never reached a server.
   */
  socket.on("connect_error", () => {
    if (!snapshot.connected) return;
    publish({ connected: false, busy: false, resuming: false });
  });

  /**
   * The socket is back — with a new identity, since a connection is not what the server
   * knows a player by, and the seat it left behind is still there to be claimed. So the
   * first thing a returning connection does is ask for it, leaving the position on the
   * screen exactly where it was: nothing about the table has changed, and replacing it
   * with the main menu for the length of a round trip would be throwing away the very
   * thing being asked for.
   *
   * The main menu is the fallback and not the rule now: it is where a connection with no
   * seat to claim lands, told why if it had a table it never learned the name of. That
   * branch is a race too narrow for the suite to provoke deliberately — it needs the socket
   * to go inside the gap between the lobby broadcast and the ack behind it — and it is kept
   * because the alternative is putting a player back on the menu with nothing said at all.
   *
   * `connected` already being true is the page's *first* connection rather than a return.
   * It has nothing to announce — except a claim made before there was a socket to make it
   * on, which is exactly what a cold boot is and is sent from here.
   */
  socket.on("connect", () => {
    const returning = !snapshot.connected;
    if (!returning && !snapshot.resuming) return;

    if (seat !== null) {
      claimSeat(true);
      return;
    }

    leaveTable(lostARoom ? UNAVAILABLE : null, true);
    lostARoom = false;
  });

  /**
   * A refusal the server sent unprompted, rather than as the answer to something asked of
   * it. It shows exactly where a rejected ack would, because it is the same news to a
   * player: something they might have expected to happen did not.
   *
   * Which means it is dropped where a rejected ack is dropped, and for the same reason —
   * an error with no room to be about is one a player on the main menu can do nothing
   * with, and being shown a red refusal for a table they are no longer at is exactly what
   * `refuse` exists to prevent.
   *
   * It does not touch `busy`, and that is the difference from an ack — whatever is in
   * flight is still in flight, and releasing the controls on news that answers none of it
   * would let a second copy of that action go out behind the first.
   */
  socket.on("errorMessage", (error) => {
    if (snapshot.view !== null) publish({ error });
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
      // Anything still queued belongs to a table this player has got up from, and a beat
      // later would sit them back down at it — as would a credential kept for a seat they
      // have just given away.
      if (leavesRoom) {
        forget();
        paced.reset();
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

  /*
   * A page that came up on a stored seat asks for it before it is anything else — in
   * particular before it is the main menu, which a null view otherwise means. Last, so
   * that a socket already connected finds every handler in place, and one that is not
   * finds the `connect` handler waiting to send the claim for it.
   */
  claimSeat();

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot: () => snapshot,

    /*
     * The ack of a seating event is the one place a resume token is ever sent (see
     * "Resume token" in CONTEXT.md), so it is written down here or not at all — there is
     * no asking for it again.
     */
    createRoom: (playerName) => {
      const name = beginEntry(playerName);
      if (name === null) return;
      socket.emit("createRoom", name, (result) => {
        if (result.ok) remember(result.value);
        settle(result.ok ? null : result.error);
      });
    },

    joinRoom: (roomCode, playerName) => {
      const name = beginEntry(playerName);
      if (name === null) return;
      // Upper-cased on the way out: a code is read aloud and typed back in, and a phone
      // keyboard does not start on capitals. The server matches codes exactly, so this
      // is the client meeting it rather than the player having to.
      const code = roomCode.trim().toUpperCase();
      socket.emit("joinRoom", code, name, (result) => {
        // The ack names the seat but not the room it is in, since the caller just said
        // which room — so the credential is completed from what was sent, in the form the
        // server matched it by rather than the form it was typed in.
        if (result.ok) remember({ ...result.value, roomCode: code });
        settle(result.ok ? null : result.error);
      });
    },

    /*
     * Ack-settled, like `startNextRound` below. An edit has one thing none of the others
     * do, and it points the same way: a refused edit is broadcast to nobody, so controls
     * waiting on a newer position would stay locked on a lobby the host is still sitting
     * in front of.
     */
    updateSettings: (settings) =>
      act((ack) => socket.emit("updateSettings", settings, ack)),

    startGame: () => act((ack) => socket.emit("startGame", ack)),

    // The view goes with the seat: there is no room to render any more, and a null view
    // *is* the main menu.
    exitToMenu: () => act((ack) => socket.emit("exitToMenu", ack), true),

    // The same shape as leaving, and for the same reason: the room this connection was in
    // is gone, so the ack is the last thing it will hear about it. A refusal — anyone but
    // the host — leaves the table exactly where it was, `act` having published nothing.
    closeRoom: () => act((ack) => socket.emit("closeRoom", ack), true),

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
      if (!isLegalCall(snapshot.view.you.hand, snapshot.view.settings.yanivThreshold)) return;

      play((ack) => socket.emit("callYaniv", ack));
    },

    /*
     * Sent through `play` rather than `act` for the same reason a turn is: the server
     * acks the slap before it broadcasts the shorter hand it produced, so the pile would
     * come back live over a position that still shows the card in hand. The lock going
     * on before the emit is also the whole of the double-tap guard — a thumb that lands
     * twice sends once, and the server would refuse the second anyway.
     *
     * Off turn, `play`'s watermark lets go on whatever position arrives first, which may
     * be the next player's move rather than the slap. Either is an answer: both are
     * strictly newer than the one it was sent from, and by either of them the window is
     * spent.
     *
     * A window drawn a beat behind the position that closed it is offered anyway, and
     * refused. Pacing arms a beat on the window's own arrival (see `pacing.ts`), so the
     * next player's move can be queued behind it for up to `PACE_MS` — the pile is still
     * flashing over a window the server has already shut. That is the same shape as
     * tapping a draw target out of turn: whether the window is still open is the
     * server's to say, it says `SLAPDOWN_NOT_AVAILABLE`, and a refusal costs the player
     * nothing. Only what the rulebook can answer is withheld ahead of it.
     */
    slapDown: () => {
      if (snapshot.busy || snapshot.view === null) return;
      if (!isSlapdownTarget(snapshot.view.you)) return;

      play((ack) => socket.emit("slapDown", ack));
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
