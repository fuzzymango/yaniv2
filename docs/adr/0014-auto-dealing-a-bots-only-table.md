# A table only bots are still playing deals itself on

The next round is dealt by any player still in the match (docs/adr/0012), which is the right
rule while there is one. Elimination (#141) made a position where there is not: every human
knocked out, two or more bots still playing, and a scored round sitting in front of a
spectator with no seat at the table that could ever ask for the next one. The match cannot
end either — it ends when one player is left, and the bots are still knocking each other out.
So the watcher sits in front of a final-looking scoreboard for as long as they care to look at
it, which is not a table that has gone quiet but one that has stopped.

Decided: **at `roundEnd`, where every seat still in the match is a bot and a human is
connected, the server deals the next round itself, `AUTO_DEAL_MS` (10 seconds) later.**

Ten seconds because the round that just finished is the thing being read — hands face up,
scores just moved — and a watched match that dealt on instantly would be a scoreboard
flashing past rather than a game being watched. It is a property of this server, like bot
think time: not a setting, not on the wire, not locked at the first deal.

## The three conditions, each of which is a rule

- **`roundEnd`, and deliberately not `gameEnd`.** A finished match waits for whoever is
  looking at it to read the standings and decide. There is always somebody who can answer for
  it, too: play again is offered to anybody still in the *room*, spectators included
  (docs/adr/0012), so the deadlock this exists to break cannot arise there. And where nobody
  is in the room, the room is being swept rather than played.
- **Every seat still in the match is a bot.** A human who has merely **dropped** still holds
  their seat, still holds their hand, and the turn still waits for them (docs/adr/0013).
  Dealing the next round out from under them is the one thing a disconnect must never cost —
  it would take the round they were mid-way through and score them for it in their absence.
  Connection is deliberately not consulted for a seat in the match; only for one watching.
- **A human is connected.** The behaviour exists to serve a watcher, and with nobody there
  the table is playing to an empty room. That is the sweep's problem (#150), not this one:
  auto-dealing into an empty room would keep a dead room's bots dealing themselves rounds
  until the process restarted.

The seat it deals *as* is a bot still in the match — `startNextRound` refuses anyone who is
not (`NOT_IN_MATCH`), and it asks for a requester. Which bot is immaterial, since the
transition opens the round on the last one's winner rather than on its requester, so the
first is taken.

## Reconsidered on every publication

The answer turns on two things: the position, and who is connected. `broadcastState` is where
both are in hand — it already reads the state and already derives connection from the room's
live sockets (docs/adr/0013) — and publishing is the only moment either of them can have
changed. So the consideration hangs off the broadcast rather than off each handler that might
produce one of those changes.

That is a deliberate widening of what a broadcast does, and it buys the property that matters:
a handler added tomorrow that publishes cannot forget, and forgetting is precisely the failure
mode being removed. It costs the consideration having to be idempotent, which it is — a pause
already running is left alone rather than restarted, or a room whose seats kept going quiet
and coming back would never get past the scored round.

Cancellation falls out of the same call: a publication whose position no longer asks for a
deal calls the pending pause off. A spectator dealing on themselves, a spectator leaving, the
last human dropping — all of them publish, and all of them are answered by one `consider`.

## Considered options

- **Deal at `gameEnd` too** — rejected above: there is always an eligible human where there is
  a human at all, and a finished match is the one position worth sitting on.
- **Make the eligibility rule "any player still in the match, or the server where none of them
  is human"** — rejected: it puts a transport-shaped exception (who is connected) inside a pure
  transition, and `startNextRound` would have to be told who is watching to answer at all.
- **Bot-play the deal from the bot turn runner** — rejected: dealing a round is not a turn, and
  the runner's whole contract is "the turn in front of this room, if it is a bot's". Two
  behaviours behind one purpose key would also break the registry's one-timer-per-purpose
  guarantee for both.
- **Schedule from the `startNextRound`/`callYaniv` handlers** — rejected: it answers the
  position changing but not the connection changing, so a spectator arriving back at a stalled
  room would find it still stalled.
- **Make the pause a room setting** — rejected: it is a fact about this server's pacing, like
  `BOT_THINK_MS`, and a room whose watchers can tune how long they are shown a scoreboard is
  not a rule of Yaniv.

## Consequences

- `TimerPurpose` gains `autoDeal`, so a destroyed room calls the pause off with everything
  else it had waiting — no new bookkeeping at the seam that destroys rooms.
- The pause elapsing against a position that has moved on publishes nothing and deals nothing:
  a spectator's own `startNextRound` is acked before it is broadcast, so it can win that race,
  and the answer to losing it is to have done nothing. Unlike an illegal bot move, this is not
  a defect and does not throw — there is no client at fault to report it to.
- A bots-only table now plays a match out to `gameEnd` on its own while somebody watches, which
  is what the suites that play matches out could not previously assume. They still seat one bot
  or play at a limit nobody is eliminated under, since the subject there is the wire rather than
  this.
- **A watcher whose connection blips restarts the pause**, since the publication with them
  absent cancels it and the one with them back starts it over. So a flaky connection can hold a
  bots-only table at a scored round for as long as it keeps flapping. Accepted: the alternative
  is a pause that survives having nobody to serve, and the failure mode it would buy — bots
  dealing themselves rounds in a room nobody is in — is worse than a table that waits for a
  watcher who keeps arriving.
- The scheduling seam is asserted twice: `autoDeal.test.ts` over the pure judgement and the
  registry, and `socketServer.test.ts` over an injected clock, where the firing and each of the
  not-firing cases is what a real client can see.
