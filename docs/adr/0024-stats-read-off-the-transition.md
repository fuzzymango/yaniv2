# Stats are read off the transition, at the one place every transition passes

An account now keeps six **stats** rather than one counter (`CONTEXT.md`, issue #209): Yaniv calls,
calls Assafed, Assafs, games completed, games won and slapdowns. ADR-0023 hung the one counter off
the `callYaniv` handler, because that handler *was* the knowledge that a human had called. Most of
the new facts have no handler of their own to hang off. A signed-in player eliminated by a **bot's**
call, the Assaf of a bot's call, a match won because the last opponent **left**: none of them passes
through the `act` of the player it credits. An elimination can come from any of five routes, and a
win from a scoring or a departure alike.

Decided: **one pure function, `statsEarned(before, after)` in `server/src/stats.ts`, answers what
every account is owed for a transition, and the socket layer asks it of every transition the room
manager accepts.** Built in #210 carrying the one stat that already existed; the other five arrive
behind it with no new plumbing.

## At the one place every transition passes

Every change to a room goes through `RoomManager.apply`: a human's move (`act`), a bot's move
(`botTurns.ts`), the auto-deal (`autoDeal.ts`) and an exit (`exitToMenu`). **`apply` hands each
accepted transition to its observers** (`RoomManager.observe`), once the new position is stored.
`createSocketServer` registers one, `recordEarned`, at construction, and it covers every route by
being where the routes meet. None of them calls it, and a route added later is counted without
anybody remembering to add a hook, which is the failure this exists to remove. It is the same
argument `broadcastState` makes for reconsidering the auto-deal and the sweep in one place.

**The room manager stays free of the store.** It knows it has observers and nothing about them. The
socket layer already owns the store and the `log`, so the write sits there.

Rejected: **a wrapper around `apply`** handed to the bot runner and the auto-dealer in its place.
It works, but every construction site then has to be handed the wrapped manager rather than the
real one, and "was this route given the wrapper?" is a question somebody has to remember to ask.

## A round scored is the scorecard growing

The Yaniv-call fact is **the scorecard growing by a row** across the transition, the key the
client's call announcement already uses (ADR-0018). The caller is `lastRoundResult.callerId` and
is credited one Yaniv call, whether the call stood or was Assafed. Where `assaferId` is set, the
same fact credits the caller a call Assafed — merged into that one delta — and the Assafer an
Assaf (#211): the one player `docs/rules.md` §6 names, so a player who tied and lost the
tie-break is credited nothing, agreeing with the red cell the table showed.

It is **not** the phase leaving `playing`. The last opponent leaving also does that, and at
`roundEnd` a departure ends the match with the scored round's result still on the state, so reading
"there is a result and the phase moved" as a call counts that call twice. Both cases are unit-tested.

Every credit goes through **`accountToCredit`**, so a bot and a guest are both null and dropped.
Increments to one account in one transition are **merged into one delta** and written in one call.
A move that earns one account several stats at once, such as a call that stood and knocked the last
opponent out, then cannot half land.

## This supersedes ADR-0023's "off the handler, not off the state"

ADR-0023 rejected reading the state because a tail firing on "the state says a Yaniv was called"
would count a **bot's** call. `accountToCredit` already makes a bot nobody, so that reason no longer
holds, and three of the new facts never pass through a human's handler at all. The `callYaniv`
handler loses its tail, and `act` loses the optional `after` parameter it had for that tail alone.

**The rest of ADR-0023 stands, and is inherited by every stat:**

- the call is counted, never the verdict;
- the write is started and **never awaited**: it is called from inside a `.then`, so it reaches the
  store only after the synchronous ack, broadcast and bot scheduling that made the move, and a store
  that throws rather than rejects lands in the same `.catch`;
- a failed write is **logged naming the account and dropped**, with no retry and no queue;
- a guest's play is **not buffered** against a future account;
- there is **no idempotency key**.

## The store's seam grows one method, not six

`recordYanivCall(id)` is replaced by **`recordStats(id, delta)`**, where `delta` is a partial record
over the six counters, applied as one atomic increment: a single `update … set a = a + …` in
Postgres, with every column in one fixed template and a counter the delta leaves out adding zero. It
is task-shaped, as ADR-0019 requires. Against an unknown account it throws, as every write on the
seam does, for ADR-0019's reasons. The seam's `Account` carries all six counters.

The schema gains the five new columns in **one appended statement**, each
`integer not null default 0`. Existing accounts read zero, since nothing before the migration was
recorded, and nothing is backfilled.

## Nothing counts twice, and the engine is why

The guarantee against double counting is **a property of the engine, not of the write**. Each fact a
stat counts (a round scored, a seat going out, the match ending, a slapdown accepted) becomes true in
exactly one accepted transition. A refused transition is never observed, and `apply` stores and
observes a transition once. So a plain increment is safe, as ADR-0023 found for the one counter.

Stated outright because it is load-bearing: **a future change that let a round be scored twice, or a
match end twice, would break these counters as a side effect**, and so would one that let a single
fact be spread across two accepted transitions.

## What no test proves

The joint is tested on the wire for the route that exists in #210, a human's own call. The Postgres
`recordStats` and the migration are checked by booting `npm run serve` against a database, as
ADR-0019 already records, since no test executes the SQL folder.
