# Slapdown's race is resolved by event order, not a timer — and is unwinnable against a bot

Slapdown (`docs/rules.md` §9) opens a window after a turn resolves: the acting player may
discard their just-drawn card back onto the pile, but only before the next player has
taken their turn. Two connections can race for that window, and the question was how the
server decides who was first.

Decided: no explicit lock, no timestamp comparison, no grace period. `RoomManager.apply`
is synchronous, and Socket.io handlers on one process run to completion before the next
begins, so whichever event — the slapper's `slapDown` or the next player's
`takeTurn`/`callYaniv` — the event loop happens to process first is authoritative by
construction. The loser's handler simply finds `round.slapdown` already cleared and gets
`SLAPDOWN_NOT_AVAILABLE`. This is the same primitive every other simultaneous action in
this codebase already resolves through; slapdown adds no new mechanism, just a new field
for it to race over.

The real consequence is what this does to bots. `playBotTurns` (`server/src/botTurns.ts`)
runs every bot-controlled turn synchronously, in the same tick as the action that handed
it the turn, with no delay — a deliberate property of this codebase (see "Broadcasting:
one send per socket, one broadcast per move" in `CLAUDE.md`), not something slapdown
introduces. If the seat after a slapdown-eligible turn is a bot, that bot's turn is
already played and broadcast before the human's client has finished processing the ack
that told them the window was even open. **A human cannot win a slapdown race against a
bot under this design — not "rarely," but essentially never**, since it requires beating
a synchronous same-tick continuation of the server's own event handler with a network
round trip and human reaction time. This is accepted for now, the same way the bot's
weak card judgement is accepted: a known, deliberate limitation, not a defect.

Two follow-ups are deferred rather than solved here:

- **Bots never slap down for themselves either.** A bot's own eligible draws are always
  left unplayed, even though slapping down is strictly beneficial with no downside. Bot
  judgement (`server/src/bot.ts`) does not reason about it yet.
- **Giving a human a real chance against a bot's next turn** would require the first
  actual timer/delay this codebase has ever introduced — holding a bot's turn open rather
  than playing it out immediately — which is a bigger change than this ADR's scope and
  should be weighed against the "no artificial delay" principle deliberately, not
  backed into as a side effect of slapdown.
