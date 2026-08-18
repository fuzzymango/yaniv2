# Milestone score reduction is always on, not a `RoomSettings` flag

Landing exactly on a multiple of 50 (`MILESTONE_INTERVAL`) after a round that added to a
player's score now drops that score by 50 (`MILESTONE_REDUCTION`) on the spot, before the
`maxScore` bust check runs. `docs/rules.md` §7.

Decided: this is a fixed rule of the engine, not a fifth `RoomSettings` field. Every value
`RoomSettings` already holds (`handSize`, `yanivThreshold`, `maxScore`, `botCount`) is
either a table-size or difficulty knob a host plausibly wants different across rooms
(docs/adr/0006). Milestone reduction is neither — it's closer to how scoring itself works
than to a room's own configuration, and turning it off would need a genuine reason ("we
don't want this variant") rather than a preference a lobby control should surface by
default. Until such a reason shows up, adding the toggle is speculative surface: one more
field every settings call site (`isValidSettings`, the lobby editor, the in-match dialog,
every fixture across three workspaces) has to carry for a choice nobody has asked to make.

`MILESTONE_INTERVAL`/`MILESTONE_REDUCTION` therefore live in `shared/src/config.ts`
alongside `ASSAF_PENALTY` — a rule constant, not a settings default — rather than in
`shared/src/settings.ts` alongside the `RoomSettings` seed values. `ASSAF_PENALTY` is the
precedent: it also decides part of `callYaniv`'s scoring, and nothing has asked to make it
host-configurable either.

## Considered options

- **A `RoomSettings.milestoneReduction: boolean` toggle** — rejected per above. If a
  concrete request for "play without it" ever arrives, this ADR is the one to revisit
  first, since the reasoning here is what would need to no longer hold.
- **Configurable interval/amount instead of a boolean** — rejected for the same reason,
  one step further: not only is "off" unrequested, so is "at a different threshold."

## Consequences

- `isValidSettings` and every settings call site are untouched by this feature — the
  reduction fires unconditionally inside `callYaniv`'s existing scoring loop
  (`server/src/game.ts`), reading `MILESTONE_INTERVAL`/`MILESTONE_REDUCTION` the same way
  `ASSAF_PENALTY` is read, not a value threaded in from `state.settings`.
- Every match, in every room, at every `maxScore`, behaves identically here — there is no
  per-room divergence to reason about, document in a lobby control, or test across.
