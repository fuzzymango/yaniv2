# A seat is claimed back by whoever took it: a guest with its token, an account with itself

A human now has two identities. An **account** outlives every room and is bound at the main menu,
where no room exists. A seat's **`resumeToken`** is issued when a seat is created and means
nothing once that room is gone. Both answer "is this the same person", and until this is settled
they can answer it differently about the same connection.

Decided: **a seat is bound to one identity for life, and claimed back by that one.** A guest seat
by its resume token, exactly as today; an account seat by its account, with the token issued and
never consulted.

Charted in issue #166; decided in #172, leaning on `Player.accountId: string | null` fixed at
seating (ADR-0019), acked auth events (ADR-0021), and the neighbouring ADR-0013 (connection
derived from the live sockets) and ADR-0016 (seats outlive their players).

## Two independent bindings on a connection

```ts
interface SocketData {
  account?: { accountId: string };               // signIn / createAccount / resumeSession
  seat?: { playerId: string; roomCode: string }; // today's `session`, renamed
}
```

An account binds at the main menu, before any room exists, and survives leaving one — so it
cannot join the one-object seat binding. Each binding stays all-or-nothing on its own, so
"half-bound" remains unrepresentable *within* either, which is the property the single object was
built for.

**`socket.data.session` is renamed `seat`.** The glossary already calls "session" double-booked
between the main menu's screen and a socket's binding; ADR-0020's session token made it three.

A socket that binds an account while already holding one simply **replaces** the binding: the
server accepts `signIn` and `signOut` in any state, and it is one connection with one person at
it. There is no `ALREADY_IN_ROOM` analogue here, because unlike a room an account binding orphans
nothing.

## A seat is bound to one identity for life

`accountId` is written when the seat is created and never changes.

- Signing in **while seated as a guest** binds the account to the *connection*. The seat stays a
  guest seat, and the account starts counting at the next room.
- Signing out **while seated** unbinds the connection. The seat stays an account seat and this
  socket keeps it — but a reload afterwards cannot claim it back, which is why #174 has sign-out
  clear `yaniv.seat` too (ADR-0020).

This closes #166's "converting a guest into an account" fog: **not in V0, by rule rather than by
omission.**

## A seat is claimed back by whoever took it

**One credential per seat, and it is the owner's.**

- A **guest seat** is claimed by its `resumeToken`, exactly as today.
- An **account seat** is claimed by its account: the connection must have that `accountId` bound.
  The token is still issued — a uniform `Player`, a uniform seating ack — but is **not consulted**.
- An account connection presenting a guest seat's token is **refused**. The token is not a back
  door around the account rule.

Every wrong-identity claim answers **`INVALID_RESUME_TOKEN`**, the code every failed claim already
gets. No new code: a distinct answer would say "this seat exists and belongs to an account", which
is the same fishing the shared code exists to prevent. The client already handles it — clear
`yaniv.seat`, one notice.

The server check is one line, and its shape is the point:

```ts
player.accountId ? account === player.accountId : token === player.resumeToken
```

**Rejected: token only, account a label.** A sign-out and a reload on a shared browser would sit
the next person in your seat, credited as you. **Rejected: token and account both required.** Two
credentials for one seat is exactly the smell this decision was opened on. Chosen because it makes
the account an identity rather than a note, and because cross-device recovery later — log in on
your phone, get your laptop's seat back — becomes purely additive: the server check above already
allows it, and only the client learning *which* seat to claim is new.

**Costs, accepted:** a session expiring mid-match at the day-30 boundary, or a sign-out followed
by a reload, loses the seat with a notice; and every account seat carries a token nothing reads.

## Newer wins at bind

`signIn` / `createAccount` / `resumeSession` **disconnects any other socket bound to the same
account** — the seat rule's mirror, and the same mechanism. A server-initiated disconnect is not
auto-reconnected by socket.io-client, so it cannot ping-pong.

A second tab at the main menu takes over; if it holds `yaniv.seat` it sits back down at the table,
exactly as a guest's second tab does today. Whether the two connections are in the same room does
not matter — the older socket is gone before the newer one joins anything.

Rejected: **older wins** (the opposite of the seat rule, and a tab left open at work locks you out
at home), and **not enforced on sockets at all** (then "one live connection per account" means
nothing).

## Joining a room your account already holds a seat in resumes that seat

`joinRoom` finds a non-departed seat with the caller's `accountId` in that room and **resumes it
instead of seating a second one**. This falls out of the claim rule — the account *is* that seat's
credential. The ack shape is unchanged; it answers with the existing `playerId`, which overwrites
`yaniv.seat`.

Consequence: **no second seat per account per room.** A *different* room is unconstrained — the
old seat idles away, as a guest's would — so "can a signed-in player be in two rooms" is answered
by newer-wins-at-bind (not on two live connections) and is not otherwise policed.

Rejected: refusing the join, which traps a player out of the room their friends are in until a
sweep that never comes while those friends are connected.

## Cold boot: session first, then seat regardless

1. On every connect: if `yaniv.account` exists, `resumeSession` and await the ack. Guests skip it.
2. Then `resumeSeat` if `yaniv.seat` exists — **whether or not the session was refused.** A
   refused session clears `yaniv.account` only; a guest seat still succeeds, and an account seat is
   refused per the claim rule and clears `yaniv.seat`. Two notices collapse into the one `notice`
   slot.
3. `resuming` stays up across both round trips, so the main menu never flashes.

This is the extra round trip ADR-0021 handed here, spent.

## What a guest is

**A human with no account**: a connection with no account bound, and a seat whose `accountId` is
null. A guest seat's identity is its resume token and nothing else; a guest's Yaniv calls are
counted nowhere.

Not a degraded state — every rule of play and every room control is the same.

**Bots are not guests.** `isBot` seats also carry `accountId: null`, but the word names a human.
Both are "no account" at the write's no-op, which is exactly why ADR-0023 asks the question in a
named function rather than inlining a null check. The CLI harness is always a guest.

## The wire carries `accountId`, and nothing else about an account

`accountId: string | null` goes on **both `SelfView` and `OpponentView`** — the handle a later
stats view taps on, public-shaped per ADR-0021.

Nothing displays it in V0; the seat label is the display name either way (ADR-0019). No other
account fact reaches a view, and the session token keeps `resumeToken`'s never-in-a-view treatment.
