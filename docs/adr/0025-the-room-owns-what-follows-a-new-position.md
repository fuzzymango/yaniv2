# The room owns what follows a new position, and the socket layer is its adapter

Every new position a room reaches is followed by the same tail: publish it to every seat, reconsider
the auto-deal (ADR-0014) and the sweep (ADR-0015), run whatever bot turns it handed over to
(ADR-0011), and credit whatever stats it earned (ADR-0024). Until now `socketServer.ts` wired that
tail by hand at every route that makes a position — `act`, `exitToMenu`, the auto-deal's callback,
the bot runner's callback — and "remember to run bot turns" was a comment in each. The rules were
testable only by opening real sockets: about 1,100 lines of `socketServer.test.ts` were about what a
room does over time, not about the wire.

Decided: **a module, `Rooms` (`server/src/rooms.ts`), owns the tail, and the socket layer reaches a
room only through it.** Decided in a grilling session off the architecture review of 25 Sep 2026; specified in #216.

## It wraps the room manager, and hides it

`RoomManager` keeps storage, seat issuing and its pure, observed `apply`, unchanged and tested as
before. `Rooms` holds it privately, together with the timer registry, the bot runner, the
auto-dealer, the sweeper and the stats write. `createSocketServer` composes `Rooms` from the manager
it is handed and uses the manager on that one line and nowhere else — so a handler cannot reach
`apply` without the tail behind it. The composition stays inside `createSocketServer` because the
port below is built over `io`, which is created there; `index.ts` and every test harness are
unchanged.

This is not the wrapper ADR-0024 rejected. That one was handed to the bot runner and the auto-dealer
*in place of* the manager, leaving "was this route given the wrapper?" to be remembered at each
construction site. Here `Rooms` constructs the bot runner and the auto-dealer itself, so there is no
site to get wrong.

## Only views cross the port

`Rooms` publishes through a synchronous port of two calls: `connected(roomCode)`, the player ids
with a live socket, and `deliver(roomCode, views)`, one `PlayerGameView` per seat. `Rooms` builds
every view itself, from one connected set, so **a `GameState` never crosses the port** —
serialization stays the security boundary, now inside the tested module, and the leak tests run
without a socket. Connection is still read off the live sockets at the moment of publishing, so
ADR-0013 holds. The one read the adapter has is `viewFor(roomCode, playerId)`, for `resumeSeat`'s
ack; there is no `getState`.

Rejected: **`publish(roomCode, state)`**, the adapter serializing per socket as `broadcastState`
did. One fewer walk of the sockets, but the adapter would hold every hand again.

## Four kinds of call, and one duty left in the adapter

- **`apply`** — a transition, followed by the whole tail.
- **`leave`** — `removePlayer`, then either the room ends (its timers cancelled, the room dropped)
  or the same tail. It answers which, and the leaver's name for `playerLeft`.
- **`createRoom`, `joinRoom`, `claimSeat`** — seating, passed through to the manager, publishing
  nothing.
- **`attendanceChanged`** — republish and reconsider, because who is connected moved.

Seating publishes nothing because it cannot: an arrival is only connected once the adapter has put
its socket in the socket.io room, and only the adapter knows when that has happened. So calling
`attendanceChanged` after binding a seat, and on a disconnect, is the one thing the adapter must
remember — and it is a transport fact, which is why it is the adapter's.

## The wire order does not change

`apply` and `leave` take an `accepted` callback, called once the transition is stored and before
anything is published, and the adapter acks inside it. So a move is still acked before its
broadcast, as `session.ts`, the CLI harness and `docs/client-session.md` all state, and the socket
suite passes unchanged across the refactor as the proof of it. Rejected: flipping to
publish-then-ack, which the clients would survive but which changes wire behaviour a refactor has
no business changing.

## Consequences

- **The stats write moves in.** `createRooms` takes `recordStats` and `log` and registers the
  observer itself, so `socketServer.ts` needs the profile store only for the account events.
  ADR-0024's decision stands; only where the observer is registered moves.
- **The room's tests move with it**, to `server/test/rooms.test.ts` against a recording port, a
  test clock and the memory store: bot think time, the auto-deal, the sweep, the empty room and the
  stats. Six wiring proofs stay in the socket suite, one per duty the adapter still has: a move
  acked before its broadcast, a disconnect republished, an arrival handed the lobby, the last seat
  leaving ending the room, a bot's turn reaching a client, and no hidden card id in a mid-round
  payload.
- **`scripts/play.ts` does not use `Rooms`.** It is a bots-only table with nobody connected, which
  `Rooms` treats as dead by design: never auto-dealt, swept after a minute. Bending that for a
  script would put a policy exception into shipped code, so `play.ts` drives `RoomManager` and
  `decideTurn` itself, and is the one importer of `RoomManager` outside `rooms.ts` and the tests.
- **It builds on #198**, the claim rule's one home in `RoomManager`, which `claimSeat` passes
  through to.
