# A client is told which seats are bots

Until now nothing on the wire said which seats the server plays. A bot was marked by its name
instead: `BOT_NAMES` were `"Grace (bot)"`, `"Alan (bot)"` and so on, so the label was baked in
before a client ever saw it, and every client showed it the same way. `views.ts` said so in as
many words: "nothing tells a client which seats are bots, and nothing should — a bot is exactly the
seat that carries no marker". The status slot leant on the same idea. A bot is connected always and
watching never, so it fell out of the rule with no case of its own, and the empty slot covered both
"somebody playing" and "a bot".

The Slate nameplate (spec #293, from #291) breaks that. It gives each seat a fixed 128×52 tile with
a badge slot, and a bot wears a robot badge there. A name that also ends in "(bot)" would say it
twice and spend a fifth of a narrow plate doing it. The badge rule (`seatBadges`) has to know which
seats are bots, and reading that off a name in shipped code is exactly the kind of guess a wire
contract is there to prevent.

Decided: **`OpponentView.isBot: boolean` is on the wire, and a bot's name is bare.**

- **Required, not optional.** It is filled from `Player.isBot` by `serializeStateForPlayer` in
  every phase, for every opponent: out, departed and away seats included. Required, so every
  fixture that builds an `OpponentView` has to say, and no construction leaves a seat ambiguous.
  That is `Player.isBot`'s own reason for being required.
- **On `OpponentView` only.** `SelfView` gets no such field. The viewer is never a bot in any client
  that draws a plate, and a bot deciding its turn from its own view has no use for the fact.
- **Public, with nothing to redact.** Which seats the server plays is plain to anyone at the table
  within a turn or two, much as `MatchStanding` is.
- **`BOT_NAMES` drops " (bot)"**, becoming `Grace`, `Alan`, `Edsger`, `Barbara`, `Tony`. Each client
  marks a bot its own way. The browser uses the plate's robot badge, and the bare name everywhere
  else (scorecard header, standings, move history). The CLI harness adds its own "(bot)" from
  `isBot`, looking up rows that carry only a player id among the opponents.
- **`spectating` stays server-derived.** A client could now work "watching" out for itself, but the
  rule stays in one place (`state.ts`) and the wire keeps sending its answer. `isBot` is for drawing
  a marker, not for re-deriving a standing.

## What it costs

- **A person may share a bot's name.** A human called "Grace" and the bot Grace now look the same
  wherever only the name is drawn: the scorecard header, the standings, the line above the felt.
  On the plate the badge tells them apart. This was accepted at spec review, and `seatBots` is
  unchanged. Rooms are joined by invite code, and the people at a table know who they invited.
- **The browser shows no marker for a bot between this change and the plate's.** That gap exists on
  the feature branch only. Nothing is released in between.

## Considered options

- **Keep the suffix and add the flag too** — rejected. The plate would say "bot" twice, once in a
  name the display-name rule could never produce. Every surface that draws a name would carry a
  label that only the plate needs to show.
- **Keep the suffix and strip it on the client for the plate** — rejected. That derives bot-ness
  from a name in shipped code, and it breaks the day a bot's name changes shape.
- **Put `isBot` on `MatchStanding`**, so both views carry it — rejected. The viewer is never a bot
  in a client that would read it, and a field on `SelfView` that is false by construction is one
  more thing to keep true.
