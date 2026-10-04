/**
 * The Socket.io transport: the adapter between connected clients and `Rooms`
 * (docs/adr/0025).
 *
 * This module only wires handlers onto an `io` instance — it never calls `listen`. The
 * process that opens a port is separate, so tests and harnesses can each stand up their
 * own server on an ephemeral port without duplicating any of this.
 *
 * What follows a new position — publishing it, the auto-deal, the sweep, the bots and the
 * stats — is `rooms.ts`'s, and no handler here can apply a transition without it: the room
 * manager is used on one line, the one that composes `Rooms`. What is left here is what
 * only a transport knows: which connection holds which seat and which account, socket.io's
 * room membership, acks, the arrival and departure announcements, and telling `Rooms` when
 * who is connected has moved.
 */

import type { Server as HttpServer } from "node:http";
import type {
  AccountView,
  Ack,
  ClientToServerEvents,
  PlayerGameView,
  ServerToClientEvents,
} from "@yaniv/shared";
import { GOOGLE_CLIENT_ID } from "@yaniv/shared";
import { Server, type Socket } from "socket.io";
import {
  createAccount,
  loadStats,
  renameAccount,
  resumeSession,
  signIn,
  type Auth,
} from "./auth/flows.ts";
import { googleVerifier } from "./auth/google.ts";
import { endSession, randomSessionToken, type SessionTokenGenerator } from "./auth/session.ts";
import type { TokenVerifier } from "./auth/verifier.ts";
import type { BotTurnRunnerOptions } from "./botTurns.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import {
  callYaniv,
  playAgain,
  slapDown,
  startGame,
  startNextRound,
  takeTurn,
  updateSettings,
} from "./game.ts";
import type { AccountId, ProfileStore } from "./profiles.ts";
import { err, ok } from "./result.ts";
import type { Claimant, Occupant, RoomManager } from "./roomManager.ts";
import { createRooms } from "./rooms.ts";
import type { Rng } from "./rng.ts";
import type { ActionResult, GameState } from "./state.ts";

/**
 * Which seat a connection holds. Set once, when the connection creates, joins or resumes a
 * seat in a room, and read by every in-game handler thereafter — a client-supplied player
 * id is never trusted, or a socket could act as any player simply by saying so.
 * `resumeSeat` is no exception: what it trusts is the credential behind the id — the token
 * for a guest's seat, the bound account for an account's — never the id.
 *
 * Stored as one optional object rather than two optional fields so a half-bound
 * connection (a room without a player, or the reverse) is unrepresentable. Called `seat`
 * and not `session`, which the main menu's screen and the session token already mean
 * (docs/adr/0022).
 */
interface Seat {
  playerId: string;
  roomCode: string;
}

/**
 * Which account a connection is signed in as, and the session that proved it — kept so
 * `signOut` can end that session. Bound by `signIn`, `createAccount` and `resumeSession`,
 * cleared by `signOut`, and read for a seat twice: the account a new seat is taken under,
 * and the one an account seat is claimed back by (docs/adr/0022).
 *
 * Beside the seat rather than inside it (docs/adr/0022): an account binds at the main menu
 * before any room exists and survives leaving one, so the two are independent, each
 * all-or-nothing on its own. The session token is held here and nowhere a view is built
 * from — it is not in `GameState` — so it has nothing to leak through but an ack.
 *
 * The display name rides along so seating a signed-in player never waits on the store: it
 * is what every bind was just answered with, and `renameAccount` keeps it current. It
 * cannot go stale behind another connection's back, an account being bound to one at a time.
 */
interface AccountBinding {
  accountId: AccountId;
  displayName: string;
  sessionToken: string;
}

interface SocketData {
  seat?: Seat;
  account?: AccountBinding;
}

export type YanivServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

type YanivSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

/**
 * What a server may be built with rather than told at runtime: the clock its bots think
 * on and how long they think for, who verifies a Google sign-in and where session tokens
 * come from — all defaulted to the real thing, so production construction is one line.
 *
 * The runner's own options plus the clock every timer in the server is set on — handed to
 * `Rooms`, whose registry every room timer is on, and to the sign-in, which dates a
 * session off it. A test seam first: a suite about something other than timing switches
 * the pause off, and one about timing drives the clock by hand; a suite that signs in
 * vouches for its own Google identities and issues marked session tokens.
 */
export interface SocketServerOptions extends BotTurnRunnerOptions {
  /** Defaults to real time. A test drives one by hand instead. */
  clock?: Clock;
  /** Defaults to Google's own, for `GOOGLE_CLIENT_ID`. A test fakes it (`test/auth/`). */
  verifier?: TokenVerifier;
  /** Defaults to a CSPRNG. A test issues marked tokens, to sweep the wire for them. */
  newSessionToken?: SessionTokenGenerator;
  /**
   * Where a failure nobody is waiting on is reported — stats the store would not record
   * (docs/adr/0023, 0024). Defaults to `console.error`; a test listens in.
   */
  log?: (...args: unknown[]) => void;
}

/**
 * Attach the game's event handlers to a new Socket.io server on `httpServer`.
 *
 * `manager` is composed into `Rooms` here and used nowhere else in this file (docs/adr/
 * 0025), so no handler can reach `apply` without what follows it. The composition is here
 * rather than in `index.ts` because the port `Rooms` publishes through is built over `io`,
 * which is created here — and so the boot entrypoint and every harness are unchanged.
 *
 * `profiles` is **required, not defaulted**, for ADR-0013's reason: a call site needing a
 * capability should not be able to forget it, and a server that had quietly composed
 * itself a store nobody chose would be a server whose accounts go wherever the default
 * went. Which store it is, is stated in the command that boots — `npm run serve` against
 * a database, `npm run serve:memory` against memory (docs/adr/0019) — and this layer is
 * indifferent to the answer.
 *
 * The sign-in events are the handlers that read it, and only through `auth/flows.ts`: they
 * hold no auth logic of their own, as the in-game handlers hold no rules. `Rooms` is handed
 * its stats write and nothing else of it.
 */
export function createSocketServer(
  httpServer: HttpServer,
  manager: RoomManager,
  profiles: ProfileStore,
  options: SocketServerOptions = {},
): YanivServer {
  const io: YanivServer = new Server(httpServer);
  const clock = options.clock ?? systemClock;
  const rooms = createRooms(
    manager,
    { connected, deliver },
    {
      clock,
      ...(options.thinkTimeMs === undefined ? {} : { thinkTimeMs: options.thinkTimeMs }),
      recordStats: (accountId, delta) => profiles.recordStats(accountId, delta),
      log: options.log ?? console.error,
    },
  );
  const auth: Auth = {
    verifier: options.verifier ?? googleVerifier(GOOGLE_CLIENT_ID),
    store: profiles,
    clock,
    newSessionToken: options.newSessionToken ?? randomSessionToken,
  };

  /**
   * Who is there right now: the player ids behind one snapshot of a room's connections
   * (issue #146) — the port's first half.
   *
   * Read off the connections that exist at the moment it is asked, which is the whole
   * reason connection is derived rather than stored (docs/adr/0013): there is no flag
   * anywhere for a drop to leave stale. A seatless socket is nobody, which is what makes it
   * safe to publish straight after a release.
   */
  function connected(roomCode: string): ReadonlySet<string> {
    const present = new Set<string>();
    for (const member of membersOf(roomCode)) {
      const playerId = member.data.seat?.playerId;
      if (playerId) present.add(playerId);
    }
    return present;
  }

  /**
   * Send every connection in a room the view `Rooms` built for its seat — the port's
   * second half. One send per socket, never `io.to(room).emit`: the views differ by seat,
   * and a connection is handed the one for the seat it is bound to and no other.
   *
   * Synchronous, walking the adapter's own set, as the port requires. `io.in(room)
   * .fetchSockets()` would be the idiomatic call, but it is async, and a publication has to
   * reach the sockets that were there when it was made.
   */
  function deliver(roomCode: string, views: ReadonlyMap<string, PlayerGameView>): void {
    for (const member of membersOf(roomCode)) {
      const playerId = member.data.seat?.playerId;
      const view = playerId === undefined ? undefined : views.get(playerId);
      if (view) member.emit("gameStateUpdate", view);
    }
  }

  /**
   * Every live connection in a room, as a snapshot.
   *
   * Copied out of the adapter's own set rather than walked in place: releasing a member,
   * or disconnecting one, mutates the very set the walk is reading. Callers that only
   * read still take the copy, so no walk here has to be checked against what it does.
   */
  function membersOf(roomCode: string): YanivSocket[] {
    return [...(io.sockets.adapter.rooms.get(roomCode) ?? [])]
      .map((socketId) => io.sockets.sockets.get(socketId))
      .filter((member): member is YanivSocket => member !== undefined);
  }

  /**
   * Release a connection from the room it is bound to: no seat, no membership.
   *
   * Both halves matter. Without the cleared seat the connection would still be told
   * `ALREADY_IN_ROOM` by every later create or join, so leaving a room would be as final
   * as it is today. Without the `leave` it would stay a member of the Socket.io room, and
   * a later room issued the same code would leak its broadcasts to a stranger.
   *
   * Clearing the seat first is also what makes it safe to publish immediately
   * afterwards: a seatless socket is neither counted connected nor delivered to, so a
   * player who has just left is never handed a view of a table they are no longer seated
   * at — which the serializer would refuse to build in any case.
   */
  function release(target: YanivSocket, roomCode: string): void {
    // Deleted rather than set to undefined: the field is genuinely absent on a connection
    // that is not in a room, which is exactly the shape a fresh connection has.
    delete target.data.seat;
    void target.leave(roomCode);
  }

  /**
   * One live connection per seat, and the newer one wins. A second tab is not
   * co-presence: two connections acting as one player would each be shown a table the
   * other could move out from under it. Dropped rather than merely unbound, so the device
   * it belongs to finds out — an unbound socket would sit there looking connected and
   * refusing every tap.
   *
   * Called *after* `claimant` is seated, not before: the drop publishes the room (issue
   * #146), and evicting first would broadcast one position with this seat absent from the
   * room's sockets — a reload would blink "away" at everybody on its way back to the table.
   */
  function evictOtherHolders(claimant: YanivSocket, roomCode: string, playerId: string): void {
    for (const member of membersOf(roomCode)) {
      if (member.id === claimant.id) continue;
      if (member.data.seat?.playerId === playerId) member.disconnect();
    }
  }

  io.on("connection", (socket) => {
    const alreadySeated = () =>
      err("ALREADY_IN_ROOM", "This connection is already in a room");
    const notSeated = () => err("PLAYER_NOT_FOUND", "This connection is not in a room");
    const notSignedIn = () => err("INVALID_SESSION", "This connection is not signed in");

    /*
     * The account, from the main menu (docs/adr/0021). Each handler is a flow and a
     * binding: every decision — whether Google vouched, whether a session is live, whether
     * a name is legal, and a payload that is not a string at all — is `auth/flows.ts`'s,
     * and all that is left here is whose connection this now is.
     *
     * Accepted with or without a seat, and binding over an account already bound replaces
     * it: unlike a seat, an account binding orphans nobody, so there is no
     * `ALREADY_IN_ROOM` for it to answer (docs/adr/0022). Bound *before* the ack, so a
     * client told it is signed in can act as the account at once.
     *
     * **Newer wins**: an account is live on one connection at a time, so any other bound to
     * it is put down — the seat rule's mirror (`evictOtherHolders`), and a tab left open at
     * work must not lock its player out at home. A server-side disconnect is not
     * auto-reconnected by socket.io-client, so two tabs cannot ping-pong. The older socket
     * is gone before this one can join anything, so whether both were in one room does not
     * matter; a seat it held is this connection's to claim, by its account.
     */
    function bindAccount(account: AccountView, sessionToken: string): void {
      // Every bind lands after an await on the store. A connection that went in the
      // meantime — the old tab of a reload, answered last — binds nothing, or it would put
      // down the live tab that has taken its place, and nothing reconnects that one.
      if (!socket.connected) return;
      socket.data.account = {
        accountId: account.id,
        displayName: account.displayName,
        sessionToken,
      };
      // Copied out first: a disconnect mutates the very map being walked.
      for (const other of [...io.sockets.sockets.values()]) {
        if (other.id !== socket.id && other.data.account?.accountId === account.id) {
          other.disconnect();
        }
      }
    }

    socket.on("signIn", async (idToken, ack) => {
      const result = await signIn(auth, idToken);
      if (result.ok && result.value.status === "signedIn") {
        bindAccount(result.value.account, result.value.sessionToken);
      }
      ack(result);
    });

    socket.on("createAccount", async (idToken, displayName, ack) => {
      const result = await createAccount(auth, idToken, displayName);
      if (result.ok) bindAccount(result.value.account, result.value.sessionToken);
      ack(result);
    });

    /** A refusal binds nothing and unbinds nothing: a refused request costs nothing. */
    socket.on("resumeSession", async (sessionToken, ack) => {
      const result = await resumeSession(auth, sessionToken);
      if (result.ok) bindAccount(result.value.account, sessionToken);
      ack(result);
    });

    /**
     * Unbound first, then the session ended, so no request arriving while the store is
     * answering is served as the account being signed out of. A seat this connection holds
     * is not touched: it was taken under the account and stays that account's.
     */
    socket.on("signOut", async (ack) => {
      const account = socket.data.account;
      delete socket.data.account;
      if (account) await endSession(profiles, account.sessionToken);
      ack(ok(null));
    });

    /**
     * Whose account is renamed is the binding's to say, never the payload's — the seat's
     * rule, one binding over. A connection with none is told its session is not valid,
     * which is the client's cue that it is a guest.
     *
     * The new name is what the next seat is taken under. A seat already taken keeps the
     * name it was taken with, as it keeps everything else it was seated with.
     */
    socket.on("renameAccount", async (displayName, ack) => {
      const account = socket.data.account;
      if (!account) {
        ack(notSignedIn());
        return;
      }
      const result = await renameAccount(auth, account.accountId, displayName);
      // Onto the binding that was renamed, and only if it is still this connection's: a
      // sign-out or another account bound while the store was answering has replaced it.
      if (result.ok && socket.data.account === account) {
        socket.data.account = { ...account, displayName: result.value.account.displayName };
      }
      ack(result);
    });

    /**
     * Whose stats is the binding's to say, as whose name is — there is no payload to claim
     * otherwise. Read off the store on every ask, so a profile opened after a match shows
     * the match (docs/adr/0026).
     */
    socket.on("loadStats", async (ack) => {
      const account = socket.data.account;
      if (!account) {
        ack(notSignedIn());
        return;
      }
      ack(await loadStats(auth, account.accountId));
    });

    /**
     * Who a new seat is taken by: the account bound to this connection, under its own
     * display name, or a guest under the name they typed. **A signed-in player is never
     * asked for a name** — whatever the payload claims is ignored — because identity is one
     * answer and not one per table (docs/adr/0019), and the seat label is then always a
     * reliable "who is that".
     */
    function seatedAs(typedName: string): Occupant {
      const account = socket.data.account;
      return account
        ? { name: account.displayName, accountId: account.accountId }
        : { name: typedName, accountId: null };
    }

    /**
     * Who this connection presents itself as to a seat that already exists: the account
     * bound to it — never one named in a payload — and whatever token it holds. Whether
     * that is enough is `RoomManager`'s to judge (`claims`, docs/adr/0022); this only says
     * who is asking.
     */
    function claimant(resumeToken: string): Claimant {
      return { accountId: socket.data.account?.accountId ?? null, resumeToken };
    }

    socket.on("createRoom", async (playerName, ack) => {
      if (socket.data.seat) {
        ack(alreadySeated());
        return;
      }

      const created = rooms.createRoom(seatedAs(playerName));
      if (!created.ok) {
        ack({ ok: false, error: created.error });
        return;
      }

      const { roomCode, playerId, resumeToken } = created.value;
      socket.data.seat = { playerId, roomCode };

      // Socket.io's own room concept maps 1:1 onto a game's room code, so broadcasts to
      // a game can address it by code directly. Awaited so membership is established
      // before the client is told it is in.
      await socket.join(roomCode);

      /*
       * The lobby is a position like any other, so it is published rather than left for
       * the client to infer from the ack — without this a host would sit in front of an
       * empty screen until somebody else turned up. `Rooms` published nothing when it
       * seated the host, since only now is there a connection in the room to publish to:
       * a seat bound is attendance changed, and telling it so is this layer's one duty.
       *
       * Published *before* the ack, unlike `act()`, which acks first. An event with no
       * listener is dropped, so this ordering settles what a client that only subscribes
       * once it is acked sees: nothing. It cannot arrive a beat later and be mistaken
       * for the position that client is actually waiting on. A client that wants the
       * lobby — the harness does — subscribes before it emits, and gets it.
       */
      rooms.attendanceChanged(roomCode);
      ack({ ok: true, value: { roomCode, playerId, resumeToken } });
    });

    socket.on("joinRoom", async (roomCode, playerName, ack) => {
      if (socket.data.seat) {
        ack(alreadySeated());
        return;
      }

      const joined = rooms.joinRoom(roomCode, seatedAs(playerName));
      if (!joined.ok) {
        ack({ ok: false, error: joined.error });
        return;
      }

      const { playerId, resumeToken, resumed, name: seatedName } = joined.value;
      socket.data.seat = { playerId, roomCode };
      await socket.join(roomCode);

      if (resumed) {
        // The account's own seat, handed back rather than a second one taken (docs/adr/
        // 0022): nobody arrived, so nobody is told so, and it is claimed exactly as
        // `resumeSeat` claims one — including off a connection that still holds it.
        evictOtherHolders(socket, roomCode, playerId);
      } else {
        // The engine's normalised name, not the raw one off the wire. `socket.to` excludes
        // the sender: an arrival is news to everyone but the arriver.
        socket.to(roomCode).emit("playerJoined", seatedName);
      }

      // Everyone, the arriver included, gets the new roster — the announcement above
      // says who turned up, this is the table they turned up to. Ordered ahead of the
      // ack for the same reason as in `createRoom`.
      rooms.attendanceChanged(roomCode);

      ack({ ok: true, value: { playerId, resumeToken } });
    });

    /**
     * Take back a seat that already exists. The credential is the whole of the check:
     * a player id is public — it names opponents in every view — so presenting one
     * proves nothing, and what says this connection is entitled to the seat behind it is
     * the token for a guest's seat and the bound account for an account's. That judgement,
     * and which refusals share a code, is `RoomManager.claimSeat`'s; this handler binds.
     *
     * A seat given up is refused by the server rather than left to the client forgetting
     * its credential: a roster is append-only from the first deal, so a departed seat and
     * its token outlive the player, and a stale tab holding one would otherwise rebind to
     * a seat its owner gave up and be handed every broadcast after it.
     *
     * The position goes back in the ack, and the room is published to behind it: a seat
     * that was away is being sat back down at, which is news to everyone looking at that
     * seat (issue #146). It was invisible until connection reached the wire, and the ack
     * still comes first — the returning client is answered by the event it sent, the way
     * every other action here is, and the broadcast reaches it as one more position.
     */
    socket.on("resumeSeat", async (request, ack) => {
      if (socket.data.seat) {
        ack(alreadySeated());
        return;
      }

      const { roomCode, playerId, resumeToken } = request;
      const claimed = rooms.claimSeat(roomCode, playerId, claimant(resumeToken));
      if (!claimed.ok) {
        ack({ ok: false, error: claimed.error });
        return;
      }

      socket.data.seat = { playerId, roomCode };
      await socket.join(roomCode);
      evictOtherHolders(socket, roomCode, playerId);

      // Built once this connection is in the room, so it counts itself as connected. The
      // room cannot have gone since the claim — the join resolves in a microtask, and every
      // way a room ends is a handler or a timer — but `viewFor` is honest that a code may
      // name nothing, and a connection is not left bound to a room that does not exist.
      const view = rooms.viewFor(roomCode, playerId);
      if (!view) {
        release(socket, roomCode);
        ack(err("ROOM_NOT_FOUND", `No room with code ${roomCode}`));
        return;
      }
      ack({ ok: true, value: { view } });
      rooms.attendanceChanged(roomCode);
    });

    /**
     * Every in-game action has the same shape: identify the caller from their seat, and
     * hand `Rooms` the transition — which, only if it stood, publishes the new position
     * and plays out whatever bot turns it handed over to.
     *
     * Acked inside `accepted`, which `Rooms` calls once the position is stored and before
     * anything is published: a move is acked before its broadcast, as `session.ts` and the
     * CLI harness both rely on. A rejection acks the error and stops there. Nothing is
     * published, so a refused action costs the player nothing: the turn is still theirs to
     * take again.
     */
    function act(
      ack: Ack<null>,
      transition: (seat: Seat, state: GameState, rng: Rng) => ActionResult,
    ): void {
      const seat = socket.data.seat;
      if (!seat) {
        ack(notSeated());
        return;
      }

      const result = rooms.apply(
        seat.roomCode,
        (state, rng) => transition(seat, state, rng),
        () => ack({ ok: true, value: null }),
      );
      if (!result.ok) ack({ ok: false, error: result.error });
    }

    /**
     * The lobby is a position like any other, so a settings change is published like any
     * other move: whoever is sitting in it sees the host's choices land. Ordinary `act`
     * shape despite there being no turn involved — the caller is identified the same way,
     * and a refusal (not the host, not the lobby, not settings a room could play on)
     * publishes nothing, leaving the room exactly as it was.
     *
     * The payload is passed on untrusted. Its wire type is a claim by whoever sent it,
     * and `updateSettings` is where that claim is checked.
     */
    socket.on("updateSettings", (settings, ack) => {
      act(ack, (seat, state) => updateSettings(state, seat.playerId, settings));
    });

    socket.on("startGame", (ack) => {
      // Seating the bots is the whole of opponent setup: a player creates a room and
      // starts the game, and never manages bots. It happens inside the transition so a
      // start that is then rejected — by someone who is not the host, say — discards the
      // seating along with it, rather than filling the table off a refused call.
      act(ack, (seat, state, rng) =>
        startGame(rooms.seatBots(state), seat.playerId, rng),
      );
    });

    socket.on("takeTurn", (action, ack) => {
      act(ack, (seat, state, rng) =>
        takeTurn(state, seat.playerId, action, rng),
      );
    });

    socket.on("callYaniv", (ack) => {
      act(ack, (seat, state) => callYaniv(state, seat.playerId));
    });

    /**
     * Ordinary `act` shape, despite not being a turn: the caller is identified the same
     * way, the transition is applied the same way, and the position it produces is
     * published the same way. Whoever asks second — the slapper who lost the race, or
     * anyone the window was never open for — is refused by the transition itself, and a
     * refusal costs them nothing.
     *
     * The bot turns `Rooms` runs behind it are a live re-entry here, not a no-op. A
     * slapdown does not move the turn on, but the seat it was handed to by the `takeTurn`
     * that opened the window may be a bot still thinking — and this call arrives inside
     * its pause. What makes that safe is the runner keeping one pending run per room: the
     * slap lands, the position updates, and the bot plays at its originally scheduled time
     * against the position the slap produced. Acting is punished in neither direction.
     */
    socket.on("slapDown", (ack) => {
      act(ack, (seat, state) => slapDown(state, seat.playerId));
    });

    socket.on("startNextRound", (ack) => {
      act(ack, (seat, state, rng) =>
        startNextRound(state, seat.playerId, rng),
      );
    });

    // Bots are deliberately not seated here the way `startGame` seats them: a seat given
    // up by an exit to the menu stays given up. Otherwise ordinary — a randomly chosen
    // opening player may well be a bot, which `act` plays out like any other handover.
    socket.on("playAgain", (ack) => {
      act(ack, (seat, state, rng) => playAgain(state, seat.playerId, rng));
    });

    /**
     * Leave the room without dropping the connection — the one exit that is not a
     * disconnect, and now the only way out of a room there is (docs/adr/0012).
     *
     * It costs the rest of the table nothing, whoever is leaving: the host is no longer
     * a special case here, because from the lobby the role migrates to the next seat and
     * from the first deal there is no role at all. What the leaver's own seat becomes is
     * the transition's business — spliced out in the lobby, marked once a match exists —
     * and whether the room ends with it is `Rooms`'.
     *
     * Everything this layer does is inside `accepted`, before the room is dropped or the
     * position published: the connection released, so the leaver is neither counted
     * connected nor published to; the ack; and then who left, to whoever stayed, ahead of
     * the table they are left with. Where the room has ended that announcement reaches
     * nobody — the leaver is out of the socket room and bots hold no sockets.
     */
    socket.on("exitToMenu", (ack) => {
      const seat = socket.data.seat;
      if (!seat) {
        ack(notSeated());
        return;
      }

      const left = rooms.leave(seat.roomCode, seat.playerId, ({ name }) => {
        release(socket, seat.roomCode);
        ack({ ok: true, value: null });
        io.to(seat.roomCode).emit("playerLeft", name);
      });
      if (!left.ok) ack({ ok: false, error: left.error });
    });

    /**
     * A connection going away, which costs the room nothing and is told to it anyway.
     *
     * **Nothing is mutated here.** The seat, the player and the room are left exactly as
     * they were, and the player behind them comes back through `resumeSeat`: backgrounding
     * a phone's browser tab drops a socket with no chance to react, and that must not end
     * five other people's match. The turn, if it was theirs, still waits for them.
     *
     * What it is told (issue #146) is that attendance changed. Connection is derived from
     * the live sockets at the moment a position is published (docs/adr/0013), so the socket
     * that has just gone is already out of the room's set — and `Rooms` republishes the
     * same position to whoever is left, which is the only way they learn a seat has gone
     * quiet. A table waiting on somebody who is not there explains itself rather than
     * merely stopping.
     *
     * It is also what starts the room's grace period, in passing rather than by name: the
     * publication reconsiders the sweep, and one with no human behind any seat is exactly
     * the position that asks for one (issue #150). A room nobody comes back to has a
     * minute left, and one whose player reloads is republished to before it is up.
     */
    socket.on("disconnect", () => {
      const seat = socket.data.seat;
      if (!seat) return;
      rooms.attendanceChanged(seat.roomCode);
    });
  });

  return io;
}
