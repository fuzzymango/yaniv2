# Room settings are host-configured, locked at `startGame`, and injected rather than ambient

Four values that were previously global constants — `HAND_SIZE`, `YANIV_THRESHOLD`,
`MAX_SCORE`, and how many bot seats get filled — become a per-room `RoomSettings` object
(`{ handSize, yanivThreshold, maxScore, botCount }`) that the host configures from the
lobby before starting a match.

Decided: `RoomSettings` lives on `GameStateBase`, so it's present in every phase, not just
`lobby`. It is editable only while `phase === 'lobby'`, via a single `updateSettings`
event that replaces the whole object atomically — matching `TurnAction`'s "one atomic
object" shape rather than four separate setters or a partial-merge event. Once
`startGame` deals the first round, settings are locked for the life of the room,
including every subsequent `playAgain` match (`playAgain` goes `gameEnd` → dealt round
directly and never revisits `lobby`, so there was never a reachable moment to re-edit
them anyway).

Every rule function that used to read one of these constants ambiently now takes the
room's value as an explicit argument instead — `canCallYaniv(hand, threshold)`, `deal`
given `handSize`, the bust check given `maxScore`. This follows the same principle
already established for `Rng` ("Randomness is injected, never ambient" in `CLAUDE.md`):
a value that can now legitimately differ per room can no longer be a module-level import.
`shared/src/config.ts`'s constants survive only as the default values a freshly created
room's `RoomSettings` is seeded with.

`handSize` is constrained to {5, 6, 7} rather than any positive integer, specifically so
`playerCount × handSize + 1 ≤ 54` (the deck's card count) can never be violated —
6 × 7 + 1 = 43 ≤ 54 regardless of how many of the 6 seats are filled. This keeps `deal`'s
existing "throws on an impossible deck, because it cannot happen" contract true instead
of turning a host's settings choice into a reachable crash. `yanivThreshold` is similarly
constrained to a fixed enum ({3, 5, 7, 11}) rather than being unbounded — both are host
*choices* among curated options, not free-form numeric input, unlike `maxScore` (any
integer 1–100,000), which has no equivalent structural reason to enumerate.

`botCount` is deliberately **not stored clamped**. A host can set it to more than
`6 - currentHumanCount` and it is simply reevaluated against the current human count
wherever it's read (display, `startGame`) rather than rejected up front or re-validated
on every join. This means a room can never refuse a join over a stale bot count, and
matches how `seatBots` already behaves today (fill what's empty, do nothing once full) —
no new rejection path was introduced for a case the room can just self-correct.

## Considered options

- **Per-field settings events** (`setHandSize`, `setBotCount`, ...) — rejected for the
  same reason `TurnAction` isn't split into `playCards`/`drawFromPile`: it would open a
  window where the object is partially updated, and gives the client four ack paths to
  handle instead of one.
- **Rejecting a join that would overflow the host's bot count**, instead of clamping —
  rejected because it makes a setting chosen early silently start blocking people later,
  which is a worse experience than the setting just quietly meaning less than the host
  asked for.
- **Re-opening settings on `playAgain`** — rejected as unnecessary complexity: `playAgain`
  doesn't pass through `lobby` today, and inventing a return trip just to let settings be
  re-edited would be new scope, not a natural consequence of this feature.

## Consequences

- `canCallYaniv` (and any future rule reading one of these four values) can no longer be
  called with just a hand — every call site (`client/src/turn.ts`, `server/src/bot.ts`,
  `server/src/game.ts`) needs the room's live settings in hand already, the same
  discipline every `Rng`-consuming function already requires.
- `PlayerGameView` carries `settings` in every phase, because `yanivThreshold` is
  load-bearing for the client's own pre-turn legality check (`isLegalCall`), not just a
  value to render — a host who changed it would otherwise silently break every other
  client's local "can I call Yaniv" logic for the rest of the match.
