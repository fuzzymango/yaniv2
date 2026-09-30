# Stats are read on their own, fresh, when a profile opens

ADR-0021 kept every stat off the wire — "viewing stats is out of scope, so the wire never carries
it, and a type is the cheapest place to make that true" — and `AccountView` has been
`{ id, displayName }` since. The **profile** (`CONTEXT.md`, issue #226) is where a signed-in player
finally sees the six counters their account has kept since #166, so a number now has to reach the
browser. The question is which payload carries it.

Decided: **a sixth account event, `loadStats(ack)`, answering `{ stats }` or `INVALID_SESSION`,
read off the store every time a profile opens; `AccountView` stays stat-free.** Built in #228. This
amends ADR-0021's "no stat on the wire" and nothing else of it.

## Not on `AccountView`

The obvious place was the account view every account ack already carries. It would be the wrong
number:

- **None of those acks happens after a match.** `signIn`, `createAccount` and `resumeSession` are
  answered at the main menu or on the way into it, and `renameAccount` by a player who has not
  necessarily played since. A player who finishes a match and opens their profile would be shown
  the stats their account had when they last signed in — the one match they came to see missing.
- **There is no natural moment to push a fresher one.** A stat write is started and never awaited
  (ADR-0023, 0024), and it lands on a connection that is at a table, not at the menu. Pushing
  stats as they are recorded is a second channel and a second set of races, for a screen opened a
  handful of times a session.

Read on open, the answer is always the store's current one, less at most a write begun a
millisecond earlier and not landed yet — a race against a person tapping through two screens,
accepted.

## One read, shaped like the other five

- **An acked event, not HTTP**, for ADR-0021's reasons: the account is bound to the connection,
  and the connection is where the answer can be refused.
- **Whose stats is the binding's to say**, never a payload's — there is no payload. A connection
  not signed in is told `INVALID_SESSION`, exactly `renameAccount`'s refusal; accepted seated or
  not, like the other five.
- **A flow and a binding.** `loadStats` in `auth/flows.ts` reads the account through the store's
  existing `loadAccount` and answers its six counters, picked field by field as `toView` picks the
  view. No change to `ProfileStore` or the SQL. A missing account is refused rather than thrown for
  — a read changes nothing, so a stale binding corrupts nothing.
- **No credential rides it.** It joins the session-token sweep in `socketServer.test.ts`.

## `Stats` moves to `shared/`

The six-counter `Stats` type moves from `server/src/profiles.ts` into `shared/src/account.ts`, so
the store and the wire share one list: a seventh counter cannot be added to the store and forgotten
by the profile, or the reverse. It is a type, so `shared` keeps its dependency-freedom.
`StatsDelta` and `NO_STATS` stay with the store, which is the only thing that writes.

## On the client, a snapshot field rather than component state

`SessionSnapshot.stats` is the tenth field, `null` or the six counters, and `loadStats()` the
intent: it blanks `stats`, emits, and fills it from the ack — and only from the ack of the latest
read made while the same account was signed in. **`stats` goes back to `null` whenever the account
standing stops being the same signed-in account** — sign-out, being signed out, another account
bound over it — in the same publication. That is a rule about the account, not about a panel, which
is why it is in the session core, where it is tested, and not in `ProfileDialog`, where it would
not be. A read locks nothing: `busy` is untouched.

## Consequences

- The profile always opens on dashes, and the numbers arrive a round trip later. Reopened, it
  starts from dashes again, so last visit's numbers are never read as this visit's.
- A refused read leaves the dashes and shows no error — the only way to be refused is not to be
  signed in, and a profile is not offered then.
- Viewing *another* player's stats is still out of scope. `OpponentView.accountId` (ADR-0022) stays
  unused, and `loadStats` takes no account to read.
