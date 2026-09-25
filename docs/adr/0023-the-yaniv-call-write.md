# The Yaniv-call write hangs off the handler, counts the call and never the verdict, and is never awaited

The engine is pure: transitions in `game.ts` return `Result<GameState>`, errors are values,
randomness and the clock are injected, and nothing reaches outside. A durable write is a side
effect and cannot go in there without breaking the property the whole codebase is built on. One
stat has to get out anyway — #166 chose **Yaniv calls** precisely because it increments at one
call site, mid-round, whichever way the match later ends.

Decided: **`act(ack, transition)` gains an optional side effect run after a successful transition,
and the `callYaniv` handler is its only caller.** The write goes last in the tail, is never
awaited, and a failure is dropped and logged.

Charted in issue #166; decided in #173, on ADR-0019's store and ADR-0022's account↔seat rule.

## Off the handler, not off the state

The socket layer knows a Yaniv call happened because it **is** the `callYaniv` handler. That is
the one fact this layer has for free.

Reading it back off the returned state — `phase === 'roundEnd'` plus a fresh `roundResult.callerId`
— or off the move history would make `act` re-derive what its caller already knew, and would
thread the store through six handlers that have no use for it.

**The rejection is worth stating rather than leaving implied: reading it off the state is the
shape that *looks* more general, and the generality is the defect.** A tail firing on "the state
says a Yaniv was called" would also fire on a **bot's** call the moment anything put the bot path
through `act` — and a bot's call is precisely what must not be counted.

## The call is counted, never the verdict

**Every accepted `callYaniv` increments, whether the call stood or was Assafed.**

The stat is *times a player called Yaniv*. Whether it stood is a fact about the round's result, not
about the call. #166 chose this counter over games played, wins and Assaf calls because those each
need a match to *end* correctly and this game has four different ways one can end; making the
increment conditional on the verdict hands that ambiguity straight back, and would make the write
read the returned state after all.

Consequence for the vocabulary: a **Yaniv call** is the act of ending the round by calling.
**Assaf** qualifies the round's outcome and says nothing about whether a call happened.

## Last in the tail, and never awaited

The tail today is ack → `broadcastState` → `runBotTurns`, all synchronous. **The write is appended
after `runBotTurns`.**

The promise is *started* there and awaited nowhere, so the tail stays synchronous end to end and
`broadcastState` still publishes the position that stood when it was called — ADR-0013's reason
for its being synchronous in the first place. Awaiting a database round trip would put network
latency between one player calling Yaniv and everyone else seeing it.

Putting it last also states the priority in the order the code reads: the game first, the side
effect after. The property a test can assert: **a store whose `recordYanivCall` never settles
still lets the broadcast go out and the next bot turn be scheduled.**

## A failed write is dropped, and logged

**No retry, no queue, no effect on the call.** A `.catch` logs — naming the account id, so a
missing account is distinguishable from a dead connection — and does nothing else. Without one, a
rejected promise takes the process down.

Rejected: **retry** (against a dead database it is a loop outliving the room; capped, it is a queue
wearing a different name); **queue** (in memory it is lost on redeploy anyway — the cost already
accepted for rooms — so it buys durability across a *short* outage only, for the price of a second
thing holding state); and **failing the call**, which is far worse than a lost counter.

**Where that is decided: in the handler's callback, not in the store.** ADR-0019's rule stands
unchanged — a store failure *throws*, because a dead database is a defect and not a rule violation.
This one caller decides its write is fire-and-forget, which keeps the exception visible at the
single site it applies to rather than weakening the store's contract for everybody.

**The accepted cost, plainly: Yaniv counts are silently lost during an outage, visible only in the
log. At-most-once, not exactly-once.**

## Bots and guests: a stated rule, in a pure function

A bot's Yaniv call never reaches the handler at all — `playBotTurn` applies `callYaniv` through
`rooms.apply` directly. So a bot is already a no-op by geography. **That is not enough**: it makes
the rule an accident of routing.

**`accountToCredit(state, playerId): AccountId | null`, in `server/src/stats.ts`** — pure, total,
and tested over its three cases:

- a human with an account → their account id
- a **guest** (human, `accountId: null`) → null
- a **bot** → null

The handler's callback is then: ask, and write if the answer is not null.

The function exists because there are **two different nulls**, and inlining `accountId !== null`
would conflate them: per ADR-0022 a null `accountId` on a human means guest, while a bot is not a
guest at all. `autoDealSeat` and `unattended` are the pattern being followed — a judgement about a
seat, decided in one pure tested function, with the layer above doing only what it is told. If the
bot path ever grows a tail of its own it calls the same function and gets the same answer.

**A guest's calls are not buffered against a future signup.** `accountId` is fixed at seating for
life and guest→account conversion is not in V0 (ADR-0022), so a buffer would be state waiting for a
conversion that cannot happen — and if it ever could, crediting one person's calls to an account
because they shared a seat id is a bug, not a feature. To be worth anything it would also have to
survive a redeploy: a second durable store, for a counter #166 calls "the proof, not the feature".

## Idempotency is derived from the engine, not defended by the write

**Nothing can double-count, and the write is not what prevents it.**

`callYaniv` is a transition *out of* `playing`: a second one returns `WRONG_PHASE`, `act` returns
before reaching its tail, and the write never fires. Exactly one accepted call exists per round,
and the write hangs off acceptance.

The paths that looked like risks, each checked: a **reconnect** publishes the position and runs no
transition; a **retry or double-tap** is the `WRONG_PHASE` case, and refused actions have no tail;
**two sockets on one seat** cannot arise, since a resume disconnects whatever socket still held it;
and a **resend after a drop** lands as the retry case, the client's watermark having been dropped.

So **no idempotency key, no round id on the write, no `ON CONFLICT`** — a plain increment is safe.
Stated outright rather than left implied, because the safety is a property of the engine being a
state machine: **a future change that let a round be scored twice would break this counter as a
side effect.**

## The shape, end to end

1. A human emits `callYaniv`.
2. `act` applies the pure transition. Refused → ack the error, no tail, no write.
3. Accepted → ack, `broadcastState`, `runBotTurns`.
4. `accountToCredit(state, playerId)`. Null for a guest or a bot → done.
5. Otherwise `store.recordYanivCall(id)`, not awaited, `.catch` logs.

## What no test proves

**Nothing proves step 5 is wired to `callYaniv` rather than to something else, or to nothing**
(#175). `accountToCredit` is unit-tested and the store is contract-tested, and both pass against a
dead pipe. `act` is a closure inside `createSocketServer` rather than an export, and a seat carries
an `accountId` only if somebody signed in — so testing this joint honestly means standing up a
server, signing in over the wire, playing to a legal Yaniv call and asserting on the store. It
**is** the end-to-end test, not a cheaper cousin of one, and exporting `act` for tests alone was
rejected as widening a module's public surface in a way this repo has so far refused.

Deliberately untested in V0, and deliberately recorded as a short step rather than a project:
#175's wire sweep gives `socketServer.test.ts` a sign-in fixture anyway, and that suite already
plays on to a legal Yaniv call in several places. **"The pipe works" is an unfalsifiable claim in
V0** — the cost #166 accepted when stats UI went out of scope, priced here rather than dissolved.

## Amended: the joint is tested on the wire, in memory (issue #191)

The wire half of the end-to-end test described above turned out to be the short step it was
priced as, and was written with the write rather than after the client: `socketServer.test.ts`
builds a server around a store it can see into, signs in over the wire through the fake
verifier and plays a real table out to real calls. It proves the counter moves for a signed-in
call — Assafed or standing alike — and for nobody else's; that a store which never answers
holds up neither the next round nor the bots in it; and that a failed write, rejected or
thrown, is logged naming the account and goes no further. **Step 5 is now wired to
`callYaniv` by a test that fails if it is not.**

What it does not prove is the same write against a real Postgres, behind a real Google
sign-in, from the real client — the half #194 still exists to check by hand, and ADR-0019's
gap rather than this one's.
