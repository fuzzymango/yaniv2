# Profiles live in Postgres, behind a narrow store the rest of the server is handed

Rooms live in a `Map` inside the process and die with it: a redeploy ends every match in
progress, and that has always been an accepted cost, because a match is a thing you were in
the middle of. An account is not. The moment the server remembers something *about a player*
rather than about a table, it needs a place to put it that a deploy does not empty — and it
needs one without the engine learning what a database is.

Decided: **profiles live in Postgres, as a managed Railway service, and every other file in
the server talks to a narrow `ProfileStore` interface it is handed rather than to a database.**
The seam is the load-bearing half; the store choice is what the seam makes reversible, which
is why both are one ADR and not two.

Charted in issue #166; decided in #169, amended by #174 (`renameAccount`) and #175 (testing,
and what a write against a missing account does).

## The choice

Three candidates survived the research (#167, #177, #178), and the research killed the free one.

**`node:sqlite` is ruled out**, and not over its `ExperimentalWarning`. Its version *is* the
runtime's, and this repo cannot choose the runtime: `railway.json` pins `NIXPACKS`, which accepts
a **major only**, so the deployed minor is whatever nixpkgs revision the Nixpacks release carries
and it moves when Railway bumps it. Production measured at **24.10.0** (#177) — below the 24.15.0
where `node:sqlite` reaches release candidate. And at 24.20.0 it is *still* `Stability: 1.2 - RC`:
it is pre-stable on every Node that can be run here. Every other candidate is pinned in
`package-lock.json` and indifferent to all of it.

**A hand-rolled file** is named only to rule it out explicitly rather than by assumption. It is
the one genuinely zero-dependency option and it fails the test this decision was set: you
hand-roll `fsync`, torn-write recovery and a query layer, and "more stats arrive later" means
growing a query language by accretion. It is the thing you would migrate off.

**`better-sqlite3` on a volume** is the honest runner-up, and #178 retired every structural
argument against it. Cost discriminates nothing — this service measures **$1.22/month**, SQLite
on a volume adds ~$0.08 and a Postgres service ~$1.20–2.50, both inside Hobby's $5. The native
build objection is dead as of v13: prebuilt N-API binaries ship inside the npm tarball, verified
by installing (842ms, no `node-gyp`, no python). And the sync-seam objection dissolves once the
interface is async **by decision** rather than by implementation.

**Postgres wins on backups.** With recovery limited to Google's (ADR-0020), the store *is* the
identity: lose the rows and the accounts are gone permanently, with no path back that does not
start at a person's Google account. Point-in-time recovery is insurance against exactly that,
and SQLite's answer — volume snapshots plus a scheduled consistent copy, since snapshotting a
live SQLite file mid-write is not guaranteed crash-consistent — is code you write and have to
remember to test.

**Driver: `postgres` (porsager), not `pg`.** Measured at decision time: `postgres` 3.4.9, **zero
dependencies**; `pg` 8.23.0, 6 direct and ~14 transitive. The count is the least of it. Its query
API is a tagged template, so parameterisation is the only shape available and there is no
string-concatenation path to reach for — worth more than a lint rule on tables holding credential
material. The counter, recorded rather than buried: `pg` has a far broader maintainer base and
`postgres` is a slower-cadence, essentially single-maintainer project. That risk is answered by
the seam, since swapping drivers behind a narrow interface is strictly smaller than swapping the
database — which is only true while the interface stays narrow.

**Two things this ADR states plainly rather than letting a reader infer.** First: **zero runtime
dependencies beyond `socket.io` is no longer reachable for profiles.** #166 licensed a dependency
as "a choice to argue for, not a forced cost"; ruling out `node:sqlite` removed the free option,
so it has gone from a possibility to a certainty. (The existing production tree is in any case 22
packages — `socket.io` plus 21 transitive — so "one runtime dependency" was only ever true at the
direct level.) Second: **ADR-0003 is not violated.** Postgres is a second *service* but not a
second *origin*: the browser still talks to one host and the database is reached internally, so
the cost 0003 priced is not incurred.

## The seam

### Asynchronous, by decision

Every method returns a `Promise`. This was settled *first*, because a synchronous interface
would have welded the store choice in place — a sync driver can be wrapped in a promise, and the
reverse cannot. With Postgres the async shape is honest rather than a wrapper, so the "async over
a sync body never exercises real interleaving" hazard does not apply.

### Task-shaped, not table-shaped

```ts
export interface ProfileStore {
  createAccount(displayName: string, credential: NewCredential): Promise<Account>;
  findByCredential(kind: CredentialKind, identifier: string): Promise<StoredCredential | null>;
  loadAccount(id: AccountId): Promise<Account | null>;
  renameAccount(id: AccountId, displayName: string): Promise<void>;
  recordYanivCall(id: AccountId): Promise<void>;
  createSession(id: AccountId, tokenHash: string, expiresAt: number): Promise<void>;
  findSession(tokenHash: string): Promise<AccountId | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteExpiredSessions(now: number): Promise<void>;
  close(): Promise<void>;
}
```

A table-shaped interface (`accounts.insert`, `credentials.insert`, `withTransaction`) is the
reflexive answer and is wrong for the reason `Clock` is not `setTimeout`'s signature: it leaks
*transaction* across the seam. Creating an account writes two rows that must land together, so a
table-shaped interface would force the caller to own atomicity and force every implementation —
the in-memory one included — to have a transaction concept. Task-shaped, the transaction is
entirely internal to `createAccount`.

`close` earns its place for an unglamorous reason: `postgres` holds a connection pool, and an
open pool keeps a `node:test` process from exiting — the same hazard `systemClock`'s `unref`
already guards against for timers.

`renameAccount` is #174's addition: the main menu gives a signed-in player a **Change name**
button, and one honest method is what that costs. It is not a leak of table shape — it is a task.

**Deliberately absent: `addCredential`.** The constraint from #168 is that the *schema* must
support a second sign-in method without invalidating accounts. That is a table shape, not an API
surface, and adding the method before anything calls it would widen the seam for nothing.

Named `ProfileStore`; the row is an `Account`. "Profile" is the feature, "account" is the thing.

### The store does not verify credentials

`findByCredential` returns the stored secret material; a separate, single, named module does the
comparison — for the Google credential that is `auth/google.ts` (ADR-0020), and **verification
lives in one named module and nowhere else.**

Considered and rejected: `authenticate(kind, identifier, presented)`, with hashing behind the
seam. It has a real security argument — one comparison site, no caller able to `===` a hash — and
it loses on three counts. Swapping `postgres` for `pg` must not mean re-implementing a KDF; the
in-memory implementation would have to either do real hashing or skip it, and skipping it would
leave the contract suite unable to assert verification behaviour at all; and the hashing decision
belongs with the credential rather than split across two decisions.

Secret material therefore crosses the seam into process memory, which it must anyway, since the
comparison happens in this process.

### Absence returns `null`; failure throws

**Absence** — no account with that id, no credential matching, no live session for that hash —
is `null`, not `Result<T>`. `Result` carries a `GameError` whose `GameErrorCode` union lives in
`shared/`: that is the *rulebook's* vocabulary, a wire contract for telling a player their move
was refused. "No such account" is not a refused move, and minting `ACCOUNT_NOT_FOUND` into that
union would push a persistence concept into the dependency-free package both clients read.
Absence is the expected answer to a *question* — `loadAccount` asks, it does not act — and
`strictNullChecks` gives the same enforcement `Result` would.

**Failure** — unreachable database, malformed query, unexpected constraint — throws. `result.ts`
already states the rule: anything that throws is a genuine defect and the socket layer lets it
propagate rather than reporting it as a rule violation. A dead database is not a rule violation,
and telling a player their Yaniv call was refused because Postgres is down is a lie about the
game. This matches `playBotTurn`, which throws for the same reason: there is no client at fault.

**`recordYanivCall` and `renameAccount` against an account that does not exist throw**, on the
same grounds — a vanished account is that kind of defect (#175). In V0 it is unreachable by
design: nothing deletes accounts and `accountId` is fixed at seating (ADR-0022), so the only
routes are a restore-from-backup or a bug, and masking either is worse than logging it. The
`.catch` at the Yaniv-call site logs it **naming the account id**, so it is distinguishable in
the log from a dead connection.

Re-creating the account from the write path was considered and **is not buildable** under
decisions already taken, which is worth recording so it is not proposed again: `recordYanivCall`
is task-shaped and takes only an id; ADR-0021 rules that the ID token is verified and dropped and
Google's `name` never persists, so at Yaniv-call time the server holds neither the `sub` nor a
name; and it would hang a re-authentication flow off a promise ADR-0023 never awaits and whose
failure is dropped. **Recovery already exists at the front door**: if the account row is gone its
`session` row goes with it, `resumeSession` answers `INVALID_SESSION`, the player lands on the
main menu as a guest with a notice, and tapping Google runs `signIn` → `nameNeeded` →
`createAccount`. The account returns through the existing path with no new code.

### Composition: required, and explicit

The store is a **required argument** to `createSocketServer` — required rather than defaulted for
ADR-0013's reason, that a call site needing a capability should not be able to forget it. The
server cannot boot without one.

Which implementation is chosen is stated in the command, not inferred from the environment:

- **`npm run serve`** reads the connection string and **refuses to start** if it is absent *or
  does not connect*. A missing database is a boot crash, the same shape a failed migration gets.
- **`npm run serve:memory`** runs the in-memory store, and needs nothing but a port.

Falling back to memory when `DATABASE_URL` is absent was rejected, and it is the important
rejection: its failure mode is the worst available — a production deploy that loses the variable
silently runs the memory store and forgets every account, in a decision made *for* durability.
Gating that fallback on `NODE_ENV` was rejected too, as the repo's second environment variable
and a concept it has never had. Local development is met by a word rather than a flag:
`serve:memory`.

### The store knows nothing about sockets

No stored connection state. #166's "one live connection per account" is worked out from the live
sockets at the moment it is asked, following ADR-0013 — a stored flag has more than one writer
and goes stale, and storing it in a *database* is worse, because the value would survive a
restart and claim someone is connected when the process holding their socket is gone.

The `session` table is not a counter-example: it records that somebody *proved who they are*,
which is durable, and never that somebody is currently attached.

## What the schema holds in V0

Three tables.

- **`account`** — id (a UUID from `randomUUID`, as `Player.id` already is), display name, Yaniv
  count, created-at.
- **`credential`** — the account it belongs to, kind, identifier for that kind, stored secret,
  created-at; **primary key on (kind, identifier)**, so one credential cannot point at two
  accounts. Two tables rather than a credential column on `account` (#168): that shape, and only
  that shape, lets a second sign-in method be added later without invalidating existing accounts.
- **`session`** — account id, token hash, expires-at, created-at (ADR-0020).

Both `credential` and `session` reference `account` **on delete cascade**. Nothing deletes an
account in V0, so this is the shape a restore or a future deletion path finds waiting rather than
a live code path.

**The stat is a plain integer column, one row per account** — not an event log, not a
name-and-value table. A name-and-value table adds a stat with no schema change at all, and an
event log gives history; both were rejected because "no migration framework" means "no Prisma or
Flyway", not "never run a schema change". Adding an integer column with a default is a fast, safe
statement in Postgres, and choosing the name-and-value shape to dodge writing it pays a permanent
loss of type safety, sorting and indexing to avoid a one-time cost. Stats are meant to be seen and
compared (#166). A counter can become an event log later if the need appears.

### The display name

A column on `account`, **separate from every credential**, chosen by the player, and what appears
at their seat. A player may sign in one way and be called anything they like; changing it touches
neither their credential nor their account id.

**For a signed-in player the account's display name always wins, and they are never asked to type
a name when creating or joining a room.** Guests type one, exactly as today. If a signed-in player
could also type a per-room name, the seat label would sometimes be their display name and
sometimes not, and the display name would stop being a reliable answer to "who is that" — which
matters because #166 settled that stats are social.

**The sign-up form requires a display name.** A fixed default such as "New Player" was proposed
first and dropped: with no settings menu, every signed-in seat would read "New Player", making an
account *worse* than no account in the one place players look.

**The name rule moves into `shared/`.** A display name follows the same rule a typed room name
already does — trimmed, 1–20 characters — so both sources of a seat label agree, and on ADR-0002's
grounds: the browser must be able to offer exactly what the server will accept rather than
send-and-be-refused. Today `MAX_NAME_LENGTH` and the trim live in `server/src/roomManager.ts` and
the browser enforces only the empty case separately; adding a second source of names is the moment
to stop keeping the rule in two places. The refusal code is the existing **`INVALID_NAME`** —
`createAccount` and `renameAccount` need no new one.

## How the schema gains fields later

**An ordered list of SQL statements in the repository, applied at startup, with a version number
in the database recording how many have run.** Adding a change appends a statement. Roughly twenty
lines.

Considered: repeat-safe statements (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) with
no version tracking — simpler, but it can only express changes that are safe to repeat, and the
first backfill or rename puts you at a psql prompt against production under pressure. And manual
changes, which leave the repository with no record of what the database looks like.

Running migrations at startup is safe here **because the service cannot run more than one copy** —
rooms live in a `Map` inside the process, so a second replica is already broken. That constraint is
sunk, exactly as the volume-forced replica pin was in #167.

**It is not a method on `ProfileStore`.** It is a function the SQL folder exports and `index.ts`
calls: the interface stays as it is, the in-memory store never learns the word migration, and a
failed migration stops the server from starting.

## Where the code lives

`server/src` is flat single-purpose files; the folder below is the line between "knows SQL" and
"does not".

- **`server/src/profiles.ts`** — the interface, its types, and the **in-memory store**. Stays
  flat, beside `rng.ts` and `clock.ts`, because it is the same kind of thing: a capability handed
  to the server rather than reached for. Nothing in it knows what a database is. The in-memory
  store is **shipped code, not a test helper** — `npm run serve:memory` runs it — so it belongs in
  `src/`.
- **`server/src/sql/connect.ts`** — reads the connection string and builds the client. **The only
  file in the repository that imports `postgres`**, so the whole cost of the dependency is visible
  by opening one file.
- **`server/src/sql/migrations.ts`** — the statement list and the function that applies what has
  not run.
- **`server/src/sql/profiles.ts`** — the Postgres implementation, **taking a client as an
  argument** rather than making one.

Named `sql/` rather than `db/`: it says what the files contain rather than what they talk to.

## Testing, and what it does not cover

**No test executes a SQL statement** (#175). `npm test` stays a single self-contained command with
no database, no fixtures and no container — a load-bearing property of this repo, preserved
outright.

The in-memory store is not a fake drifting from a real one: per the placement above it is
**shipped code**, so this is two implementations of one interface, only one of which any test
runs. **The contract suite is parameterised over a `() => ProfileStore` factory from day one**,
with the in-memory implementation the only registration — which makes adding the Postgres arm one
line rather than a rewrite. **That suite is the specification of the interface**, not an extra: it
asserts the happy paths and every edge the interface can express (a `findByCredential` miss, a
duplicate `(kind, identifier)`, `recordYanivCall` and `renameAccount` against an unknown account).
What the in-memory store cannot honestly prove — the two-row atomicity of `createAccount`, and
concurrent increments — is named in the **suite's header comment**, not written as skipped tests: a
skipped test is a TODO nobody reads.

Rejected, each for its own reason: a `DATABASE_URL`-gated arm skipped otherwise — with no CI and
no local Postgres it runs nowhere while making the suite *look* like it covers the driver, and an
arm nobody runs is worse than no arm; a suite that provisions its own database, which needs Docker
and ends `npm test` being self-contained; and a hand-run `npm run smoke:sql` script, since an
unrun script rots faster than an unrun test.

**The cost, stated:** `server/src/sql/` and the migration list are executed by nothing but a real
boot. A wrong column name, a malformed tagged template or a broken migration is found by running
the server. Accepted for V0; the fix is CI with a `postgres` service, roughly 25 lines and the
first CI this repo has had — deferred rather than dismissed.
