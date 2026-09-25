# The client's session core

How `client/src/session.ts` behaves: the snapshot it publishes, what locks and releases
`busy`, how an account and a seat are claimed back and what a dropped socket does. `docs/client-table.md`
is its sibling — that one is the felt, this one is the wire behind it. Referenced from
`CLAUDE.md`, which keeps only the shape.

## The snapshot, and the hook over it

The browser client's logic lives in `client/src/session.ts`, a plain module outside React that
owns the socket and exposes exactly two things: a `SessionSnapshot` to read and a set of intents
to call. `useSession` subscribes to it with `useSyncExternalStore` and holds no logic — **if
that hook ever grows a branch, the branch is in the wrong place.** The point is testability: the
session core is driven under `node:test` against a real socket server, with no browser, no jsdom
and no React test dependencies. Components are not tested at all, a consequence of that split
rather than a gap — behaviour worth testing belongs in the session core or in one of the pure
modules beside it (`turn.ts`, `seating.ts`, `fan.ts`, `flight.ts`, `ghosts.ts`, `flip.ts`,
`timing.ts`, `settings.ts`, `scorecard.ts`). `useCardFlight` is the one hook outside
`useSession`.

Snapshots are **replaced wholesale, never mutated**: `useSyncExternalStore` compares by
identity. Nine fields, and each answers a different question:

- **`view`** — the position, or `null`. Null *is* the main menu: the one screen not a function of
  `view.phase`, there being nothing sent before a room exists — `resuming` qualifies it, below.
- **`account`** — where the connection stands on identity, **tagged**: `guest`, `nameNeeded`
  (Google vouched, a name to confirm, prefilled with `suggestedName`) or `signedIn` with its
  `AccountView`. Tagged on `SelfView`'s precedent, so "signed in with no name" is unrepresentable.
  Independent of `view`, as the server's two bindings are. See "Accounts" below.
- **`error`** — a `GameError`: something the player asked for and was refused, or one the server
  pushed as `errorMessage`. Cleared the moment they try again — a refusal costs them nothing.
- **`notice`** — news that is *not* a refusal: a seat that could not be claimed back, or a session
  that has lapsed. No action to blame and nothing to retry, and it arrives while they sit still.
- **`connected`** — whether there is a socket to play over (this session's own, not the wire's
  per-seat `connected`). See "A session that loses its socket" below.
- **`resuming`** — an account or a seat is being claimed back and the answer has not landed.
  Always rides with `busy`, and says what `busy` cannot: a null view is a table (or an account)
  still being asked for rather than the main menu. See "Claiming a seat back" below.
- **`selection`** — the cards tapped for the next turn, by id, in tap order. Here rather than in a
  component because it has to survive views arriving underneath it: `retainSelection` on every
  broadcast of a position still being played drops whatever has left the hand, which is also what
  empties it after a committed turn. A broadcast of any *other* phase empties it outright rather
  than filtering — a card id is the same string every round, so a choice carried across a deal
  would come back chosen over its inheritor — as does a position this viewer is only **watching**,
  where `toggleCard` refuses a tap too, so a watcher's selection is empty at every moment (#149).
- **`flight`** — the move the position was reached by, when there is one worth watching happen.
  The **one-shot**: `publish` clears it unless the publication being made is the one drawing that
  move, so a tap, a refusal or a reconnect never flies a card again. Decided in `show`, by asking
  `flight.ts`. See "Card flight" in `CONTEXT.md`.
- **`announcement`** — the call a scored round arrived on, ordered, and null otherwise. The same
  one-shot in the same place, asking `announcement.ts` — which keys on the **scorecard growing**,
  never on a round result standing. See "Call announcement" in `CONTEXT.md` and docs/adr/0018.

**`busy` locks on emit, and settles two different ways.** Entering or leaving a room, and all
five account events, settle on the **ack** — the account events producing no position at all, so
there is no newer broadcast to wait for: entry has been broadcast before it is acked, and a departing
connection is published to no longer. So do dealing the next round, dealing another match,
and editing the room's settings, which produce a position rather than moving within one —
and, in the settings case, none at all when refused, since a rejected edit is broadcast to
nobody. A **move settles on a strictly newer position** — a turn, the Yaniv call that replaces
one, or a slapdown, all sent through the same `play` helper, which keeps the CLI's
`Position { view, version }` / `actedOn` watermark in the session core. A slapdown is the one
of the three sent off turn, so what releases it may be the next player's move rather than its
own answer; both are strictly newer, and by either the window is spent. The server acks an
in-game action *before* it broadcasts the result, so controls released on the ack would come
back to life over a position still showing the mover's own turn. A rejected move is the
exception and releases at once: nothing was published, so no newer position is coming. The
ordering trap, plainly: the first snapshot carrying a view after entering a room is one the
player still cannot act from — tests wait on `view !== null && !busy`, not the view alone.

**A position is drawn the moment it arrives.** No queue between the socket and the snapshot: the
server spaces bot turns out itself, so there is no burst left to smooth (#135).

**A tap the rules do not permit sends nothing and says nothing.** `turnFrom` answers with
`null`, `commitTurn` returns, and no error is published — the screen should not have offered a
target that lands there; `callYaniv` is the same shape via `isLegalCall`. **What is legal about
the cards** is all the client applies ahead of the server (ADR-0002); everything else it owns is
offered, sent, and refused by it.

**Leaving is the one action answered by the ack alone.** Everything else is confirmed by the
broadcast behind it, but the server stops publishing to a connection that has left, so
`exitToMenu` clears the view itself.

**A rejection that lands after the room has gone is swallowed, not shown** — a player's own exit
crossing an action still in flight acks `PLAYER_NOT_FOUND` about a room they have left, so an
error is dropped whenever `view` is already null. **An `errorMessage` shows and is dropped
exactly where a rejected ack is**, being the same news, **but does not touch `busy`**: it is
nobody's answer, and letting go would put a second copy of the action on the wire.

**`playerJoined`/`playerLeft` are deliberately unhandled.** The roster arrives right behind each
as a fresh view, and a screen that re-renders in place shows a seat filling or emptying by
itself. The CLI needs those nudges only because its frames scroll apart.

**The client never enforces a rule the server owns.** Showing the start control to the host
alone is a courtesy, so a guest is not hunting for a button that was never theirs; the rule is
`NOT_HOST` and the server says it. The deal is the same — drawn for a viewer still in the match,
enforced by `NOT_IN_MATCH`. Refusing an unusable name — for a room, or for an account — is the one exception,
the rule being `shared`'s (ADR-0002).

## Claiming a seat back

The session holds its seat's `ResumeRequest` in two places, and the split is the whole
design: **in memory**, which survives a dropped socket, and in an injected **`TokenStore`**,
which survives the page. `createSession` takes the store the way it takes its socket — no
global is reached for below `main.tsx` — and defaults to one that keeps nothing, so a session
given none still resumes across a live reconnect and starts over on a reload. The real one is
`seatStore` (`tokens.ts`), one `localStorage` key holding one seat, built in `main.tsx` alone.

The credential is written down at the two ways in and nowhere else, the ack of a seating
event being the only place a token is sent; `joinRoom`'s names the seat but not the room, so
the room is completed from what was sent — upper-cased as the server matched it. It is
forgotten in exactly two cases: the player's own `exitToMenu`, and a claim the server refuses.
**A dropped connection is pointedly not one of them.**

A claim goes out on session creation (a stored seat, i.e. a cold boot) and on every
reconnect, and **nothing is emitted into a socket that is down**: socket.io would buffer it,
the `connect` handler sends one anyway, and the second is answered `ALREADY_IN_ROOM` — a
refusal indistinguishable from a seat that has gone. So `claimSeat` publishes `resuming` and
emits only if `socket.connected`; `resuming` and `connected` go up in one publish, or a
screen would read the moment between them as the main menu. A refused claim clears the
credential and lands on `view: null` with one `notice` — the same sentence a room that has
gone gets, the server deliberately not drawing that distinction. A successful one publishes
the acked view with nothing in flight: a table sat back down at, not a move anybody watched.

## Accounts

**Neither credential is ever on the snapshot.** The Google ID token `signIn` is handed is held in
a private variable while a name is `nameNeeded`, because `createAccount` resends it, and dropped
the moment that step ends — signed in, "Not now" (`cancelSignIn`, which sends nothing: nothing
was bound), or a `createAccount` refused `INVALID_CREDENTIAL`, Google's tokens being short-lived.
A refused *name* leaves the step open. The **session** token is what survives a reload, so it is
held in memory and in an injected **`AccountStore`** — `accountStore` in `tokens.ts`, its own
`localStorage` key, `yaniv.account`, with the seat's fail-quiet rules. The suite sweeps every
snapshot of a sign-in and of a resume for both, by marked token.

**Signed in, a room's name is the account's.** `createRoom`/`joinRoom` send the account's display
name and never read the one passed in, so the menu needs no field and no branch; the server
ignores a signed-in payload's name anyway (docs/adr/0022).

**Sign-out is the main menu's.** It sends nothing from a table (#174 §2): it forgets **both**
keys (docs/adr/0020), and at a table the seat is the one being sat in. Both are cleared before
the emit and Google's `disableAutoSelect()` is called — injected as `GoogleSignIn`, `google.ts`
being the one file that knows `window.google` — so a reload mid-flight cannot sign back in. A
`renameAccount` refused `INVALID_SESSION` lands where a lapsed session does, below.

## Claiming an account and a seat back

**Every connect presents the session first, then the seat** (docs/adr/0022): the seat may be the
account's, and claiming it before knowing who is asking asks the wrong question. The seat is
claimed whether or not the session was refused — a guest seat is its token's either way — and
`resuming` stays up across **both** round trips, so the moment between them never reads as the
main menu (or as a guest's menu). Every *reconnect* does the same, the server's account binding
dying with the socket. A refused session clears `yaniv.account`, lands as a guest, and carries
**one** `notice`: it outranks the seat's own, an account's seat refused to a guest being the
same piece of news. A guest seat claimed behind it keeps that notice until the player next acts.

## A session that loses its socket

**`connected` is asked about before the view is.** A dropped socket makes every control on every
screen a lie, whatever the last position drawn still shows, so `App` renders `Disconnected.tsx`
above everything — the second screen that is not a function of `view.phase`. It starts `true`,
before the socket has connected: socket.io buffers what is emitted before then, and a page
announcing a lost connection for the first moment of every load would be crying wolf.

**A drop leaves the player on the disconnected screen, and the connection coming back sits them
straight back down.** `disconnect` drops the watermark and releases `busy` — nothing is in flight
over a socket that is not there, a claim included — but leaves the view alone, that screen being
over it anyway and very likely the position still there on return. The *reconnect* claims the seat
rather than clearing anything: `connect` sends `resumeSeat` with the credential the session holds,
and the position comes back in the ack. The main menu is the fallback for a returning connection
with no seat to claim; a drop at the menu costs nothing and says nothing.

**A connection that never arrived is the same screen.** `connect_error` is treated the way
`disconnect` is, the two being indistinguishable to whoever is looking at them; only the first of a
run of failed retries is news. **Nothing argues about the tab closing** either — the `beforeunload`
warning went with #66, a page carrying that listener being held out of the back/forward cache.

