import type { AccountView, SignedIn, SignInResult } from "./account.ts";
import type { GameError } from "./errors.ts";
import type { RoomSettings } from "./settings.ts";
import type { PlayerGameView } from "./views.ts";

/** Where the single drawn card comes from. See docs/rules.md §3. */
export type DrawAction =
  | { source: "deck" }
  | { source: "discard"; cardId: string };

/** A whole turn: discard a set, then draw one card. Indivisible. */
export interface TurnAction {
  discardCardIds: string[];
  draw: DrawAction;
}

/** Standard ack callback shape for request/response events. */
export type Ack<T> = (
  result: { ok: true; value: T } | { ok: false; error: GameError },
) => void;

/**
 * What a returning client presents to be let back into a seat it already holds.
 *
 * All three parts are needed and none of them is trusted: the room and the player name
 * the seat, and the token is the only thing proving the caller is entitled to it — a
 * player id alone is public enough to appear in everyone else's view.
 */
export interface ResumeRequest {
  roomCode: string;
  playerId: string;
  resumeToken: string;
}

export interface ClientToServerEvents {
  /*
   * The account, from the main menu (docs/adr/0021). A connection's account is bound
   * independently of any seat it holds — it arrives before any room and survives leaving
   * one — so every one of these is accepted in any phase, seated or not, and binding an
   * account over another simply replaces it: unlike a seat, an account binding orphans
   * nobody. Nothing here changes a seat already taken.
   *
   * The session token is a credential with the resume token's treatment: handed over in
   * the ack of `signIn` or `createAccount` and nowhere else, never in a view.
   */
  /**
   * Present a Google ID token. A known credential is signed in and bound; a new one is
   * answered `nameNeeded`, and `createAccount` is the step after. Refused with
   * `INVALID_CREDENTIAL` if Google did not vouch for it.
   */
  signIn: (idToken: string, ack: Ack<SignInResult>) => void;
  /**
   * The confirm-name step: the same ID token again, and the name chosen. The token is
   * resent rather than remembered for the connection, so nothing is ever half signed in.
   * `INVALID_CREDENTIAL`, or `INVALID_NAME` for a name the display-name rule refuses.
   */
  createAccount: (idToken: string, displayName: string, ack: Ack<SignedIn>) => void;
  /**
   * Present a session token back, on connect, and be bound to its account.
   * `INVALID_SESSION` if it has lapsed, been signed out, or was never issued.
   */
  resumeSession: (sessionToken: string, ack: Ack<{ account: AccountView }>) => void;
  /** End this connection's session and unbind its account. Fine when there is none. */
  signOut: (ack: Ack<null>) => void;
  /**
   * Change the name the bound account is known by — from the next room on; a seat
   * already taken keeps the name it was taken under. `INVALID_NAME`, or
   * `INVALID_SESSION` from a connection not signed in.
   */
  renameAccount: (displayName: string, ack: Ack<{ account: AccountView }>) => void;
  /**
   * The ack of the event that seats a player is the one place their resume token is
   * handed over — never a broadcast, never another player's view. See CONTEXT.md.
   */
  createRoom: (
    playerName: string,
    ack: Ack<{ roomCode: string; playerId: string; resumeToken: string }>,
  ) => void;
  joinRoom: (
    roomCode: string,
    playerName: string,
    ack: Ack<{ playerId: string; resumeToken: string }>,
  ) => void;
  /**
   * Bind this connection to a seat that already exists, and hand back the position it
   * stands in. Distinct from `joinRoom`, which seats somebody new: this one takes no
   * name, admits nobody, and works in every phase.
   *
   * The view comes back in the ack rather than as a broadcast because it is the answer
   * to this call and to nobody else's — a resume is invisible to the rest of the table,
   * which is told nothing about who is or is not connected. The token is not sent back:
   * the caller just presented it, and a credential belongs on the wire once.
   *
   * A seat holds one live connection. If another is still bound to it, that one is
   * disconnected as this one takes over. Refused with `INVALID_RESUME_TOKEN` if the seat
   * or the token is wrong, and `ROOM_NOT_FOUND` if the room has gone.
   */
  resumeSeat: (request: ResumeRequest, ack: Ack<{ view: PlayerGameView }>) => void;
  /**
   * Host only, lobby only: replace the room's settings wholesale. docs/adr/0006.
   *
   * The whole object, never a patch — a partial merge would open a window where a room
   * is playing under half of one host's choices and half of another's, the same reason
   * a turn is one `TurnAction` rather than a discard followed by a draw. All four fields
   * land or none do: anything out of range is refused with `INVALID_SETTINGS`, and
   * `startGame` locks the lot for the life of the room.
   */
  updateSettings: (settings: RoomSettings, ack: Ack<null>) => void;
  startGame: (ack: Ack<null>) => void;
  takeTurn: (action: TurnAction, ack: Ack<null>) => void;
  callYaniv: (ack: Ack<null>) => void;
  /**
   * Put the card just drawn straight back down, out of turn, while the window the last
   * turn opened is still open. docs/rules.md §9.
   *
   * No payload: a player draws exactly one card per turn, so the server already knows
   * which card this is about — and taking one on trust would let a caller name any card
   * they liked. Losing the race to the next player's turn is answered with
   * `SLAPDOWN_NOT_AVAILABLE`, the same as never having had a window at all.
   */
  slapDown: (ack: Ack<null>) => void;
  /**
   * Deal the next round from a scored one. Asked by any player still in the match —
   * nobody is host once the cards have gone out (docs/adr/0012) — and refused to a seat
   * the match has gone on without with `NOT_IN_MATCH`.
   */
  startNextRound: (ack: Ack<null>) => void;
  /**
   * From a finished match: another match for the same table, dealt at once. Asked by
   * anyone still in the room, spectators included — a match may have been won by a bot,
   * and a bot asks for nothing. docs/adr/0012.
   */
  playAgain: (ack: Ack<null>) => void;
  /**
   * Leave the room, from the lobby or a finished match. It costs the rest of the table
   * nothing: the seat is freed or marked, and the room plays on for whoever remains —
   * there is no longer any way for one player to end everyone else's game. See CONTEXT.md.
   */
  exitToMenu: (ack: Ack<null>) => void;
}

export interface ServerToClientEvents {
  /** Sent per-socket, never broadcast raw — each player gets their own view. */
  gameStateUpdate: (view: PlayerGameView) => void;
  playerJoined: (playerName: string) => void;
  playerLeft: (playerName: string) => void;
  errorMessage: (error: GameError) => void;
}
