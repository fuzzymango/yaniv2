# Bot think time paces the server — the slapdown window and the client pacer both follow from it

ADR-0005 named the problem and declined to solve it: a same-tick bot turn made a slapdown
against a bot unwinnable by construction, and giving a human a real chance would need "the
first actual timer/delay this codebase has ever introduced," weighed deliberately rather than
backed into. This is that timer.

Decided: a bot's turn is **scheduled, not played in the tick that handed it over**.
`createBotTurnRunner` (`server/src/botTurns.ts`) waits out **bot think time**
(`BOT_THINK_MS`, `server/src/config.ts`, 1500ms) before deciding, and a chain of bot turns —
five in a row, on an empty table — is walked one link at a time, each waiting out its own
pause. Uniform: every bot, every turn, a round opening on a bot included, not only the one
that follows a human. `CONTEXT.md` names the pause **bot think time** and the rhythm it
produces at the table **the beat** — a server-side fact now, not a client one.

## Why the pause is uniform

Only the bot seated after a human has a slapdown window to protect — a bot never opens one
for itself (below), so every other pause in a chain has nothing to race. A pause scoped to
exactly that turn was considered and rejected: it would need the runner to know, turn to
turn, whether the seat it is about to play follows a human's just-opened window or another
bot's ordinary turn, splitting one timer into two meanings for a distinction that buys
nothing — a chain of bots reads as a game being played only if it *is* one throughout, not
paced for a human's benefit on the one turn a human happens to be watching and instant on
the rest. One constant, applied everywhere, is what keeps `BOT_THINK_MS` a single number a
test can assert against and a table can be retuned by.

## Why the window falls out of it rather than existing as its own mechanism

ADR-0005 already resolves *who* wins a race for the window — event order, no lock, no
timestamp — and that is untouched here. What was missing was time to race *in*: a same-tick
continuation gave a human's client no window between the ack that opened it and the bot
already having closed it. Bot think time closes that gap as a side effect of pacing every
bot turn, not as a mechanism aimed at slapdown — there is still no window timer, only the
pause the next bot takes before its turn, exactly as ADR-0005 left it. A human can now win
the race the same way a second human always could: by being faster than whichever event the
server happens to process first.

## Why the client pacer is retired, not adjusted

Before this, bot turns landed on the client in a burst — the whole chain resolved
server-side in one tick — and a client-side queue (`session.ts`'s own clock) spaced them back
out into a readable rhythm after the fact. With the server now spacing the broadcasts
themselves, one per think time, that queue reproduces a rhythm the wire already has: two
clocks agreeing by construction rather than one clock stating a fact. Issue #135 deletes it
outright — the queue, the session core's injected clock, and everything the queue dragged
behind it — rather than leaving it in place as a redundant smoothing layer that could drift
from the server's own pacing under a real network. **The beat survives the deletion as a
word**: what a player sees is unchanged, only which side produces it.

## Considered options

- **Pause only the bot immediately after a human's turn** — rejected above: two meanings for
  one timer, for a distinction the table's own readability doesn't want.
- **Keep the client pacer alongside the server's spacing** — rejected: a second clock
  reproducing a rhythm the first already produces is drift waiting to happen, not a
  safety net.
- **A window timer, independent of bot pacing** — the option ADR-0005 flagged and deferred.
  Rejected in favor of think time doing double duty: a dedicated timer would be the
  codebase's *second* one, for a window that a uniform pace already opens wide enough.

## Consequences

- `BOT_THINK_MS` is the codebase's one timer, in `server/src/config.ts`, not a `RoomSettings`
  field, not on the wire, and not locked at the first deal — a property of this server, not
  of a room.
- A human can win a slapdown against the bot seated behind them, inside the pause that bot's
  turn takes — no longer "essentially never," which is what makes ADR-0005's own bolded claim
  to that effect now false rather than merely dated.
- **Accepted cost: a full table laps in roughly seven and a half seconds** — five bot seats
  at `BOT_THINK_MS` each, the most a single human at a six-seat table waits between their own
  turns.
- **Accepted cost: a flight can be cut short.** What guarantees a card's flight
  (`client/src/timing.ts`'s `FLIGHT_MS`) finishes before the next position replaces it is bot
  think time being comfortably longer than it — not a guarantee the wire enforces. A network
  that bunches two broadcasts together can still land a second position mid-flight; cosmetic,
  and only reachable on a connection that has already stuttered.
- Bots still never slap down for themselves (ADR-0005's other deferred half, unchanged here):
  the window this ADR makes winnable is always the *next* bot's, never the eligible bot's own.
