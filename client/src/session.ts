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
import { MAX_DISPLAY_NAME_LENGTH, normalizeDisplayName } from "@yaniv/shared";
import type { Socket } from "socket.io-client";
import type { Announcement } from "./announcement.ts";
import { announcementFrom } from "./announcement.ts";
import type { CardFlight } from "./flight.ts";
import { flightFrom } from "./flight.ts";
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
   * News about the room that is not a refusal of anything the player did — today, only a
   * seat that could not be claimed back. Separate from `error` because there is no action
   * to blame and nothing to retry: it is the last thing they hear about that room, and it
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
  /**
   * The move the position was reached by, when it is one worth watching happen: a turn — the
   * cards that left a hand for the pile and the card that came back the other way — or a
   * slapdown, which is one card going the one way. Null the rest of the time, which is most
   * of it.
   *
   * A one-shot: it is set by the publication that draws the position it belongs to and is
   * gone from the next one, whatever that next one is about. That is what makes it an event
   * to play rather than a fact about the table — a card is in flight for as long as the
   * animation takes and not for as long as the position stands, so a tap or a refusal
   * arriving behind it does not put the same cards up again.
   *
   * What it does *not* do is count renders: a component that re-renders off the snapshot it
   * already has reads the same flight, and it is the one flight either way. Playing each
   * exactly once is the animating layer's own job, and the object's identity is what it has
   * to tell them apart by. `flight.ts` decides what is in it; nothing here re-decides.
   */
  readonly flight: CardFlight | null;
  /**
   * The call a scored round arrived on, when it is one this viewer was there to hear: the
   * seat that called Yaniv and, where the call did not stand, the seat that took it off
   * them — ordered, the call first. Null the rest of the time, which is most of it.
   *
   * The **same one-shot as `flight` above and for the same reasons** (issue #156): it is set
   * by the publication that draws the position it belongs to and is gone from the next one,
   * whatever that next one is about. That is what makes it an announcement of an event
   * rather than a record of a fact — the round stays scored on the screen long after the
   * banners have faded, and the line above the felt and the scorecard are what carry it.
   *
   * A second field rather than a second shape of `flight`: a flight is cards moving and this
   * is a word over a seat, and the one broadcast that produces this — a Yaniv call — is
   * precisely the one that produces no flight at all. `announcement.ts` decides what is in
   * it; nothing here re-decides.
   */
  readonly announcement: Announcement;
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
   * Leave the room without dropping the connection, and go back to the main menu. The
   * only way out of a room there is: nobody can end anybody else's game (docs/adr/0012),
   * so this costs the rest of the table nothing and the caller's own seat is all it is
   * about, whoever the caller is.
   *
   * Answered by the ack alone: the server stops publishing to a connection it has turned
   * out of a room, so nothing is coming behind it.
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
   * Deal the next round from a scored one. Open to any player still in the match — nobody
   * is host once the cards have gone out (docs/adr/0012) — and the server is what says so,
   * answering a seat the match has gone on without with `NOT_IN_MATCH`.
   */
  startNextRound: () => void;
  /**
   * Deal another match to the same table from a finished one — scores back to zero and the
   * first round dealt on the spot, with no stop in the lobby. Open to anyone still in the
   * room, whether or not the last match went on without them: a match may have been won by
   * a bot, and a bot asks for nothing (docs/adr/0012).
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
 * never sent away from the menu and back. The rule is `shared`'s and the server applies
 * the same one (ADR-0002) — this is the client declining to offer a move it already
 * knows will be refused, not the client deciding a rule of its own.
 *
 * The sentence is this screen's own, and asks for a name rather than reporting on the
 * one that was typed: both ways of failing the rule are answered here, and the commoner
 * of them by far is a field nobody has typed into yet.
 */
const UNUSABLE_NAME: GameError = {
  code: "INVALID_NAME",
  message: `Enter a name of 1-${MAX_DISPLAY_NAME_LENGTH} characters to create or join a room`,
};

/**
 * What a player is told when the seat they were in cannot be had back: the room has gone
 * from the server, or the credential offered for it was refused. News rather than a
 * refusal — they did nothing to cause it and there is nothing to retry.
 *
 * One sentence for both ways of losing a seat, because they are one thing to whoever is
 * reading it: that table is not there to go back to. Which of them it was is a distinction
 * only the server could draw, and it deliberately does not — `INVALID_RESUME_TOKEN` covers
 * a wrong token and an unknown seat alike, so a room code cannot be used to fish for the
 * seats behind it.
 */
const UNAVAILABLE = "That game is no longer available.";

export function createSession(
  socket: YanivClientSocket,
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
    flight: null,
    announcement: null,
  };
  const listeners = new Set<() => void>();

  /**
   * `flight` and `announcement` are cleared unless the publication being made is one that has
   * a move or a call to show, which is what makes them one-shot: nothing has to remember to
   * put either back down, and no publication about something else — a tap, a refusal, a
   * connection going — can leave the last move on the screen to be flown a second time or the
   * last call to be announced twice.
   */
  const publish = (next: Partial<SessionSnapshot>): void => {
    snapshot = { ...snapshot, flight: null, announcement: null, ...next };
    for (const listener of listeners) listener();
  };

  /**
   * How many positions have been drawn, and which one a turn is waiting to be played past.
   *
   * The counter is the CLI's `Position` and `actedOn` watermark, kept here rather than in
   * a component because it is the same fact about the same wire: the
   * server acks a turn *before* it broadcasts the result, so for a moment after a move
   * the last view still shows the mover's own turn and their discarded cards in hand.
   * Controls released on the ack would come back to life over that stale position.
   *
   * Arriving and being drawn are the same instant — a position goes to the screen off the
   * wire, with nothing in between — so there is one count and not two.
   *
   * *Any* newer position releases it, not only the one the turn caused — which is the
   * same thing wherever it matters, since nobody else can move while the turn is ours.
   * Off turn it lets go early, on a broadcast from whoever is actually playing; the turn
   * being sent again from there is refused either way.
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
   * A position this viewer is only *watching* is the same case (issue #143): they hold no
   * hand for a choice to be about, and the shape they are sent has none to filter against.
   *
   * Stated once and here, because a seat claimed back answers it the same way an arriving
   * broadcast does.
   */
  const carriedInto = (view: PlayerGameView): readonly string[] =>
    view.phase === "playing" && !view.you.spectating
      ? retainSelection(snapshot.selection, view.you.hand)
      : [];

  /**
   * A position reaching the screen, which is the moment it reaches the client: there is no
   * queue between the socket and the snapshot (issue #135). A run of bot turns is spaced
   * out by the server, a think time apart, so the rhythm a player watches is a fact about
   * when the moves happened rather than one the client manufactures.
   *
   * A committed turn's lock is released here and only here, on a strictly newer position
   * than the one it was played from.
   *
   * It is also the one place that holds the outgoing position and the arriving one at the
   * same time, which is what a move to animate is read from.
   */
  const show = (view: PlayerGameView): void => {
    version += 1;
    const played = committedAt !== null && version > committedAt;
    if (played) committedAt = null;

    publish({
      view,
      flight: flightFrom(snapshot.view, view),
      announcement: announcementFrom(snapshot.view, view),
      selection: carriedInto(view),
      busy: played ? false : snapshot.busy,
    });
  };

  socket.on("gameStateUpdate", show);

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
   * Not seated any more. Exactly two things reach here: the player giving the seat up, and
   * a claim the server refuses. A dropped connection is pointedly not one of them — that is
   * the case the seat is kept *for*.
   */
  const forget = (): void => {
    seat = null;
    tokens.clear();
  };

  /**
   * There is no table any more: back to the main menu, told why if there is anything worth
   * telling. The one way out of a room that the player did not ask for, and every way in
   * to it ends here — a seat that could not be claimed back, and a connection that came
   * back holding nothing to claim with.
   *
   * A turn in flight is one nobody will answer now, and a selection is a tap or two made in
   * front of a table that is no longer there. Neither goes to the next room.
   *
   * `reconnected` rides along rather than being published beside this, because a screen
   * that saw `connected` come back a moment before the view went would draw the dead table
   * as a live one.
   */
  const leaveTable = (notice: string | null, reconnected = false): void => {
    forget();
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
      // to this call and to nobody else's — so it is counted in like any other position,
      // and published here rather than through `show`: nothing flies on it, since a table
      // being sat back down at is a position landing rather than a move anybody watched,
      // and whatever last happened at it may be several turns old.
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

  /*
   * There is deliberately no handler for a room ending under a player sitting in it,
   * because nothing ends one that way any more (docs/adr/0012): a room ends when its last
   * seat leaves, and that seat is the one leaving. What is left of that case is a seat
   * that cannot be claimed back when the connection returns, which `claimSeat` answers
   * with `UNAVAILABLE`.
   */

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
   * already locked on an earlier attempt, or what was typed is not a usable name.
   *
   * Locking here rather than at each intent is what makes the guard cover both ways in,
   * and the shared rule answers here for the same reason — one check covering both
   * doors, and the same one the server will apply to whatever this sends.
   */
  const beginEntry = (playerName: string): string | null => {
    if (snapshot.busy) return null;

    const name = normalizeDisplayName(playerName);
    if (name === null) {
      publish({ error: UNUSABLE_NAME });
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
   * longer exists — this player's own exit crossing an action still in flight, the server
   * having dropped their session, so the ack comes back `PLAYER_NOT_FOUND`. They are
   * already on the menu, and blaming them for it on top would be exactly what a refusal
   * must never cost.
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
      // A credential kept for a seat this player has just given away would only sit them
      // back down at a table they have got up from.
      if (leavesRoom) forget();
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

    // Choosing costs nothing and asks for nothing, so there is no error to clear and no
    // lock to take — only the one already held by a turn on its way out.
    toggleCard: (cardId) => {
      if (snapshot.busy) return;

      // A viewer the match has gone on without holds no hand for a choice to be about
      // (issue #143), so a tap names a card they do not have: the same silence `commitTurn`
      // and `callYaniv` answer them with, one step earlier. `carriedInto` already empties
      // the selection on every position such a viewer is sent; this is what keeps it empty
      // between two of them, so a watching snapshot has nothing pending in it at any moment
      // rather than only just after one arrived.
      if (snapshot.view !== null && snapshot.view.you.spectating) return;

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
      // is this player's turn is left to the server, exactly as it is for a discard. A
      // viewer who is only watching has no hand to call on, which `turnFrom` answers for
      // the other half of the same screen (issue #143).
      const you = snapshot.view.you;
      if (you.spectating) return;
      if (!isLegalCall(you.hand, snapshot.view.settings.yanivThreshold)) return;

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
     * A window the server has already shut is still offered until the position that
     * closed it arrives, and the tap is refused. That is the same shape as tapping a draw
     * target out of turn: whether the window is still open is the server's to say, it says
     * `SLAPDOWN_NOT_AVAILABLE`, and a refusal costs the player nothing. Only what the
     * rulebook can answer is withheld ahead of it.
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
