# Starting player is chosen at random, not the host

Every new game (the first `startGame` from the lobby, and every subsequent `playAgain`)
previously gave the opening turn to the host — a simple rule, but one that gives the host
a small, permanent first-move advantage over every other player at the table,
indefinitely, for as long as they keep hosting. As the "play again" flow makes it trivial
to run many games back to back with the same host, that advantage compounds instead of
averaging out.

Decided instead: the starting player for any new game is chosen uniformly at random from
the seated players (humans and bots alike). This replaces the "host starts round 1" rule
in `docs/rules.md` §2. It does not touch round-to-round starting order within a match —
the previous round's winner still opens the next round (§6) — only which player opens
game 1.
