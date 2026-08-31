# The room dies with its last human, after a grace period

A room ends when its last seat *leaves* (docs/adr/0012), and that answers every exit a player
actually takes. It answers none of the ones they do not: a tab closed, a phone backgrounded,
a laptop shut, a train going into a tunnel. A disconnect deliberately costs a room nothing —
the seat, the hand and the turn are all left exactly as they were (docs/adr/0013) — so a room
whose humans all dropped stood for as long as the process did, holding a match in memory, and
where the table had bots in it, playing turns out to nobody.

Decided: **a room is destroyed once no human has been connected to it for `ROOM_SWEEP_MS`
(60 seconds), and destroying it cancels every timer it holds.**

## Not on the drop

The whole of `resumeSeat` exists because a drop is survivable, and **a reload is a
disconnect** — there is no event that distinguishes the two, and there should not be. A room
swept the moment its last socket went would mean a lone human against bots loses their match
to the second it took the page to come back, which is precisely the cost that seat resumption
was built to remove. Nothing about the sweep may make a disconnect final.

So it is a grace period, and a minute is the number: long enough for a reload, a backgrounded
tab coming forward or a tunnel, short enough that abandoned tables do not accumulate in a
server that keeps every room in memory. Like bot think time and the auto-deal pause it is a
property of this server — not a setting, not on the wire, not locked at the first deal.

**The accepted cost** is the other side of it: a room whose humans have all dropped goes on
playing bot turns for up to a minute, publishing to nobody. The alternative — pausing a room's
bots while nobody is watching — is a second mechanism with its own resume, and it buys sixty
seconds of one table's arithmetic.

## Who counts as attending

`unattended` asks one question of a position and the connected set: is there no seat held by a
**human, not departed, with a connection behind it**?

- **Bots are counted out rather than waited on.** A bot never leaves and never asks for
  anything, so a table of them with the last human gone is a room playing to an empty screen —
  and, with no player left who could leave, one nothing else would ever end.
- **A departed seat is nobody's.** It has been given up; whatever still holds its id is not
  somebody the room is for.
- **Out of the match is not out of the room.** A spectator watching the bots that beat them is
  attending — they are exactly who the auto-deal deals for (docs/adr/0014).

Connection is derived from the room's live sockets at the moment of publication, as everywhere
else (docs/adr/0013), so there is no flag for a drop to leave stale.

## Reconsidered on every publication, and asked once more at the end

The sweep hangs off `broadcastState` for the reason the auto-deal does (docs/adr/0014):
publishing is the one moment the position and who is connected are both in hand, and it is the
only moment either can have changed. A handler added tomorrow that empties a room cannot
forget. Both considerations are idempotent, so a room with nobody in it publishing its bots'
moves neither restarts the countdown nor starts a second one — a countdown restarted by each
of those would never finish, which is the leak this exists to close.

The question is then asked **once more when the pause elapses**, against the live sockets. A
returning connection cancels the sweep by publishing, and `resumeSeat` seats itself before it
publishes — so a claim landing in the last tick of the minute would otherwise have its room
swept out from under it. One `unattended` call at both ends, so the judgement cannot come out
two ways about the same pause.

## Timers, and the process

The pause is set on the room's timer registry (`roomTimers.ts`) under its own purpose, so
`destroyRoom` calls it off along with the bot that was mid-think and the deal that was pending —
one call, naming no behaviour. That is the invariant the registry was built for: a room that
has ended stops doing things, and no callback is left to fire at a code that may be issued
again.

`systemClock` is now unreferenced, which follows from the same idea one level up: everything on
that clock is work a *room* has waiting, and none of it is a reason for a **process** to stay
alive. Without it a server asked to shut down would sit out the longest grace period first.

## Considered options

- **Destroy on the last disconnect.** Simplest, and wrong: it makes every reload fatal.
- **Sweep on a periodic scan of all rooms with a last-seen timestamp.** A second notion of time
  in the server, a stored field for a drop to leave stale, and a sweep that fires up to an
  interval late — for no property the per-room pause does not already have.
- **Pause a room whose humans have all gone, and sweep the paused ones.** Removes the minute of
  bots playing to nobody, at the cost of a suspended-room state every layer above would have to
  learn, and a resume that has to restart it.
