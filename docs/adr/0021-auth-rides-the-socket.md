# Auth rides the socket contract, and `shared/` learns the account types and only the types

`ClientToServerEvents` / `ServerToClientEvents` is the entire contract between this server and
its clients, and `staticServer.ts` is a hand-rolled file server with no routing at all. An
account is the first thing this codebase has ever asked a player to prove, and it arrives with
the question of whether proving it belongs on that contract or beside it.

Decided: **authentication rides the socket contract as acked events**; `shared/` gains the
account **types** and nothing else; the server's auth code is a folder under `server/src`; and a
session token is treated exactly as a resume token is.

Charted in issue #166; decided in #171, amended by #174 (`renameAccount` as a fifth event) and
#175 (the fake verifier's placement, and a serializer assertion withdrawn as vacuous).

Most of this was settled upstream and is confirmed here rather than reopened: **socket, not
HTTP**, because the GIS button flow has no redirect, which is the fact that won it (ADR-0020);
**no new workspace**, `server/src/profiles.ts` and `server/src/sql/` being placed already
(ADR-0019); verification behind an injected `TokenVerifier` in one named module; the client ID and
the display-name rule in `shared/`; and the two refusal codes.

## Events, not `socket.handshake.auth`

Both credentials ride **events with acks**, and `handshake.auth` is not used at all.

- `signIn` is needed regardless: the button is tapped mid-connection at the main menu, and
  `handshake.auth` is fixed at socket creation. A handshake would be a *second* mechanism beside
  it, not a replacement for it.
- `resumeSession` on connect is `resumeSeat`'s shape one level up — emitted from the client's
  `connect` handler, answered in the ack. One pattern for claiming a credential back.
- A refused session must land on the main menu as a guest with a `notice` (ADR-0020). That is an
  ack shape. A handshake refusal can only reject the connection or silently bind nothing.
- The session core's tests already drive events with acks against a real server.

**Cost, accepted:** middleware would have bound the account before any handler ran, guaranteeing
order against `resumeSeat` for free. With events, the client chains the two on a cold boot —
`resumeSession`, await the ack, then `resumeSeat` — one extra round trip. ADR-0022 spends it.

## The codes join `GameErrorCode`

`INVALID_CREDENTIAL` and `INVALID_SESSION` go into the existing union under a new `// account`
group. Not a second union: `GameErrorCode` is already "every way a client request is refused" and
not the rulebook alone — `ALREADY_IN_ROOM` and `INVALID_RESUME_TOKEN` are transport codes living
there today. One union keeps one `Ack<T>` and one `error` slot on the client's snapshot; a second
would mean a second `Ack` type and a second slot the client handled identically.

ADR-0019's objection to `ACCOUNT_NOT_FOUND` is not in tension with this: that was about store
*absence* leaking onto the wire, and these are wire refusals.

**A refused display name reuses `INVALID_NAME`**, which the union already carries for a typed room
name. The rule is one rule in one place (ADR-0019), so it answers with one code.

## `shared/` learns the account types, and only the types

**`shared/src/account.ts`**, on `views.ts`'s grounds: both clients read the wire, so the shapes
live where neither can drift from it.

- `AccountView { id, displayName }` — what a signed-in menu draws. **No Yaniv count**: viewing
  stats is out of scope, so the wire never carries it, and a type is the cheapest place to make
  that true.
- The `signIn` ack: `{ status: 'signedIn', sessionToken, account }` or
  `{ status: 'nameNeeded', suggestedName }` — the confirm-name step (ADR-0020).

In `events.ts`: `signIn(idToken, ack)`, `createAccount(idToken, displayName, ack)`,
`resumeSession(sessionToken, ack)`, `signOut(ack)`, and — #174's addition —
`renameAccount(displayName, ack)`.

**The confirm step resends the ID token** rather than the server holding a pending `sub` on the
socket. There is nothing half-bound to represent, which is the same property `socket.data`'s
one-object bindings are built for, and the token lives an hour.

Stays out of `shared/`: the verifier, the store, session minting. Server only.

## `server/src/auth/`

A folder, no barrel, mirroring `profiles.ts` / `sql/profiles.ts`'s interface-here-driver-there
split:

- **`auth/verifier.ts`** — the `TokenVerifier` interface. The **fake lives in `server/test/`**,
  not here: #175 found that the shipped caller justifying a `src/` home does not exist, since the
  CLI never signs in (ADR-0020) and the browser renders no button when Google's script fails
  (#174). `serve:memory` runs the real verifier against the in-memory store.
- **`auth/google.ts`** — **the only file importing `google-auth-library`**, exporting
  `googleVerifier(clientId): TokenVerifier`, composed in `index.ts` beside the store as
  `sql/connect.ts` is. The dependency's whole cost is visible by opening one file, which is
  ADR-0019's rule applied to the second dependency as well as the first.
- **`auth/session.ts`** — session-token minting (CSPRNG, `Player.resumeToken`'s shape, behind an
  **injectable generator**) and SHA-256 hashing. The one place the hash is computed.
- **`auth/flows.ts`** — `signIn` / `createAccount` / `resumeSession` / `renameAccount` as
  functions over `(verifier, store, clock)` returning `Result`. `socketServer.ts` handlers call
  these and hold no auth logic of their own.

## The security boundary, in three tiers

**1. The session token gets `resumeToken`'s treatment.** Never in a view, in any phase; on the
wire exactly once, in the `signIn`/`createAccount` ack. The store holds only its hash.

The test that guards it is **not** a serializer mutation test, and #175 withdrew the one this
decision originally asked for as **vacuous**. `resumeToken` is a field on `Player` inside
`GameState`: the serializer holds it and must drop it, so breaking the serializer on purpose fails
the test. The **session token is never in `GameState` at all** — it lives in the `session` table
and on `socket.data` — so "no session token in a view" would pass against a deliberately broken
serializer, which in a repo that treats "mutation-tested" as a real claim is worse than no test.
It is dropped, **with a comment in its place saying why**, so a future reader does not helpfully
add it back.

Two assertions with teeth replace it:

- **The wire sweep.** The injectable generator issues **marked** tokens, mirroring
  `markedResumeTokens` / `RESUME_TOKEN_MARK` in `server/test/helpers.ts`. Every payload the server
  emits to every socket across a full scenario is recorded, and the mark must appear in **exactly
  one** of them — the `signIn`/`createAccount` ack. The mutation is emitting it anywhere else.
  It lives in `socketServer.test.ts`, beside the `resumeToken` sweep it copies.
- **The store holds only the hash.** The stored value is not the token handed out. The mutation is
  storing the raw token in `auth/session.ts`.

**2. The ID token and Google's `name` never persist and are never logged.** The token is verified
and dropped; `name` reaches the `nameNeeded` ack and goes no further. **Enforced by type**:
`NewCredential` has no field for either, so this tier needs no test.

**3. The account id is public-shaped, not a secret** — a UUID like `Player.id`, and it reaches
both views (ADR-0022). No test treats it as a credential; one positive assertion instead, that it
**does** reach both views, so a future over-zealous redaction is caught.
