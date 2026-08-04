# `shared/` owns the rulebook

`shared/` was scoped as types and the event contract only, deliberately free of logic, with
`rules.ts` sitting in `server/src` alongside the engine. Building a browser client broke
that: a client cannot reach into `server/src` at all, and the CLI harness had already
proved the need by importing `pickupCandidates` from there — a client must offer exactly
the pickups the server will accept, or it lies about the game.

Decided: `rules.ts` moves to `shared/` whole, and `config.ts` splits with it. The rule
constants (`HAND_SIZE`, `YANIV_THRESHOLD`, `MIN_RUN_LENGTH`, `MIN_RUN_REAL_CARDS`,
`ASSAF_PENALTY`, `MAX_SCORE`, `MIN_PLAYERS`, `MAX_PLAYERS`) go to `shared/`; `BOT_NAMES`
and `ROOM_CODE_*`, which are operational rather than rules, stay on the server. `shared/`
remains dependency-free — every function in `rules.ts` is already pure over `Card` values.

`rankToValue` went with them, from `deck.ts` to `cards.ts`. It was not in the original
list, but the scoring table is `docs/rules.md` §1 as much as the threshold is §6, and the
move exposed that: `shared`'s own tests need to build cards, and leaving the table on the
server would have meant a second copy of a rule, free to disagree with the first. Building
a deck stays on the server; deciding what a rank is worth does not.

Moving only the handful of functions the client needs was considered and rejected. The
constants are entangled: `canCallYaniv` reads `YANIV_THRESHOLD`, and `isRun` reads
`MIN_RUN_LENGTH` and `MIN_RUN_REAL_CARDS`. Worse, `canonicalizeSet` — which would have
stayed behind — calls the private `isRun`, so the split would have exported an internal
helper purely to serve one server-side caller and divided the rulebook across two files
along a line no reader could infer, only to be migrated again the first time the client
wanted `legalDiscards` to highlight playable cards.

This does not weaken the security boundary. The rules are public knowledge; what must never
reach a client is hidden state, and that remains `serializeStateForPlayer`'s job. Nor does
it make the rules less singular — `docs/rules.md` is still the source of truth, and the
constants still point at it.

The client depends on this for its central interaction: draw targets light up only when the
current selection is a legal discard, so an illegal set is never offered rather than being
sent and silently refused. Without `isValidSet` on the client that affordance is
impossible, and a tap that does nothing is indistinguishable from a tap that did not
register.
