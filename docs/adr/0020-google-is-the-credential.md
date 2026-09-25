# Google is the credential, and our own session token outlasts it

An account is only worth having if a player can get back into it, and #166 set the test for how
they prove they own one: **simple enough to build quickly, robust enough not to be substantially
replaced later.** A choice that has to be torn out in six months fails even if it ships tomorrow —
which is what rules out the two cheapest answers before the comparison starts, a bare name claim
and a device-only token, both of which are dead ends requiring a migration.

Decided: **Sign in with Google — the Google Identity Services ID-token flow — and it is the only
credential kind in V0.** Google decides *who*; a session token of our own remembers *that they
proved it*.

Charted in issue #166; researched in #168; decided in #170, amended by #174 (the lazy script load,
and sign-out clearing both browser keys) and #175 (the session-token generator is injectable, and
the fake verifier is a test helper).

## Why Google, and why the research's own pricing was wrong

#168 priced OAuth as having "the largest HTTP surface of any option" — and it priced the
**authorization-code redirect flow** (`/auth/google/start` → 302 → `/auth/google/callback`), which
would have forced this repo's first HTTP routing layer. The GIS **button** flow is a different
thing:

- The browser receives a **signed ID token (JWT) in a JavaScript callback**. Redirect URIs are
  optional — Google's own docs say credentials "may be returned using a redirect … rather than
  through a JavaScript callback". The token therefore rides the existing socket contract exactly
  as a password would: **no HTTP surface**, which retires OAuth's biggest cost and is the single
  fact that decided this.
- Verification is four checks — RS256 signature against Google's cert set, `iss`, `aud`, `exp`.
- Identity is **`sub`**, never email: Google says to use `sub` alone, as it "is unique among all
  Google Accounts and never reused".
- Setup is a Cloud project, the consent-screen branding form, and the production host plus
  `http://localhost:<port>` as Authorized JavaScript origins — localhost explicitly allowed.
- Publishing status, which #168 left open: **Testing caps at 100 users**; clicking *Publish app*
  with only `openid email profile` requires **no verification and shows no "unverified app"
  warning**. Publish before sharing with anyone beyond the test-user list.

**Against password, the runner-up.** Password has no HTTP surface either, and its hole is
**recovery**: with no email service a forgotten password is a destroyed account, and closing that
hole means building email anyway. Google's recovery is Google's. Build effort is comparable, and
Google removes three things password would have had to design — a KDF and its memory budget, a
brute-force surface and its rate limiting, and a signup form that could be spammed.

**Against the other three.** The **account key** is the device-only token #166 already ruled out
plus a copy-paste step, with the one failure mode that cannot be migrated. **Passkeys** are the
option that genuinely *would* be torn out: the RP ID **is** the domain, production is on a
Railway-provided hostname with no custom domain, and adding a domain later would invalidate every
credential — a natural second kind once the domain is settled, not the first. An **email code** is
the best recovery anchor and needs a domain you do not own and a provider, with deliverability
failures the server cannot see; the right thing to add *second*.

### Costs, accepted

1. **A Google account is the only door to a profile.** Guests are unaffected and are not a
   degraded state. Anyone unwilling or unable to use Google has no account. Said out loud.
2. **Two external runtime touchpoints:** Google's script in the browser, Google's cert set on the
   server at sign-in. **Google down means sign-in down, never play down.**
3. **The CLI harness plays as a guest.** No browser, no ID token, and nothing to fix.
4. Google's button carries branding rules and is a third-party script on an otherwise asset-free
   client.
5. A hostname change is a console edit to the authorized origins — accounts keyed on `sub` survive
   it.

## Verifying the token

**`google-auth-library`** (`OAuth2Client.verifyIdToken`), which is what Google's docs recommend.
Measured at decision time: v11.1.0, 6 direct and **29 packages** total. Hand-rolling on
`node:crypto` (~100 lines, no package) and `jose` (1 package) were both considered and rejected on
one ground: the place where a silent mistake is an account takeover is the place to take the
vendor's maintained implementation of cert rotation and claim checks.

**The standing principle this settled, recorded because it outlives this decision:** adding
packages is acceptable. Scrutinise each for whether it is required and useful; do not argue
against one on dependency count alone, and do not hand-roll to keep the count low. `shared/` stays
dependency-free because the client imports it; the server's count is not a target. CLAUDE.md's
"`socket.io` is the only runtime dependency" is a description of history, not a rule to defend.

Tests cannot reach Google, so `verifyIdToken` sits behind an injected **`TokenVerifier`** — the
`Rng`/`Clock` move — and verification lives in that one module and nowhere else (ADR-0019).
**The fake verifier is a test helper and lives in `server/test/`**, not in `src/`: #175 found that
the "shipped caller" justifying a `src/` home does not exist, because the CLI never signs in and
the browser renders no button when Google's script fails. **`serve:memory` therefore means the
in-memory store with the *real* Google verifier** — the store and the verifier are two independent
injections, the client ID is committed, and localhost is an authorized origin. The accepted cost:
signing in under `serve:memory` needs network and a console entry. Offline local sign-in would
need a dev-only input standing in for the button the client declines to render — not built, and
not wanted for its own sake.

## First sign-in: a confirm-name step

Token verified, no `credential` row for that `sub` → the client shows **one field, prefilled with
Google's `name`** → `createAccount`. One extra screen, first time only.

Rejected: creating the account on the tap with Google's `name` as the display name. ADR-0019 made
the display name *chosen*; a real name at a card table is not everyone's choice, and with no
settings menu in V0 they would be stuck with it. (The rename button #174 added is the escape hatch
for the name once chosen, not a reason to choose it for them.)

## What is stored, and what a leak would cost

- **`credential`:** `kind = 'google'`, `identifier = sub`, `secret = NULL`. **Nothing else from
  the token** — not email, not picture, not name. The name goes to the `nameNeeded` ack and no
  further.
- **`account`:** as ADR-0019 has it — id, display name, Yaniv count, created-at.

`secret` stays a column so a password kind can use it later without a schema change; for this kind
it is null. **A store leak costs nothing in V0**: a `sub` is not a secret and cannot be replayed.
The only sensitive column in the schema is the session token hash below.

Why not email: PII the game never uses, Google says not to key on it, and storing it would make it
the future recovery anchor without ever having been verified for *this* app.

## Recovery

**Google's.** Lost phone, forgotten password — Google's flow, nothing here.

The residual, accepted and recorded **as the decision rather than as an oversight**: *losing the
Google account itself loses the yaniv account.* No admin path, no merge. A second credential kind
later is the mitigation, and it is not this effort's.

## The session

Google's ID token lives one hour, so something must outlast it.

**Our own session token.** On sign-in the server mints a CSPRNG token — `Player.resumeToken`'s
shape, behind the same kind of **injectable generator** — stores its **SHA-256** in the `session`
table and hands the raw token to the browser. A random token needs no slow KDF; a single hash
makes a leaked table useless. The generator is injectable for a second reason #175 found: without
it there is no marked token to sweep the wire for, and the security assertion below cannot be
written at all.

Rejected: re-asking Google on every load via GIS `auto_select`. It needs no table, and One Tap
cooldowns, FedCM and Safari's ITP suppress it unpredictably — players would find themselves signed
out at random. "Google owns auth" still holds under our own session: Google decides *who*, the
session only remembers *that they proved it*.

- **Lifetime: 30 days, fixed from issue.** No sliding renewal — a write per connect for no gain.
  Day 31 is one tap on the button again.
- **Cleanup, two layers:** `findSession` treats an expired row as absent (`null`) and deletes it;
  `deleteExpiredSessions` runs at startup and every 24 hours on the injected `Clock`, unref'd like
  the room timers. Single process, so there is nothing to coordinate.
- **Sign-out** deletes the row, clears the browser keys, and calls
  `google.accounts.id.disableAutoSelect()` so Google does not sign them straight back in.
- Signing in elsewhere does **not** revoke other sessions. "One live connection per account" is
  ADR-0022's, enforced on sockets rather than on sessions.

## In the browser

A second `localStorage` key, **`yaniv.account`**, holding the session token — the `tokens.ts`
pattern exactly: injected storage, fails quiet, junk under the key reads as "no session", handed
to `createSession` beside the seat store.

The token is presented on **every connect, before any room exists**. A refused session — expired,
revoked — clears the key and lands on the main menu as a guest with a `notice`, the same shape a
refused seat claim already gets.

**Sign-out clears both keys — `yaniv.account` and `yaniv.seat`.** This is #174's correction to
this decision's first form, which had them fully independent with signing out never dropping a
seat. ADR-0022 made an account seat claimable **by its account**, so a surviving `yaniv.seat`
after sign-out points at a seat that is permanently unclaimable: the next cold boot would fire a
doomed `resumeSeat` and show a notice for nothing. One rule, no flag on the seat key, no stale
claim. The accepted cost is narrow — a **guest** seat taken before signing in is forgotten at
sign-out, and the room code gets them back.

In the other direction the keys stay independent: **leaving a room never signs anyone out.**

## The script loads lazily, and fails silently

The GIS script (`accounts.google.com/gsi/client`) is loaded **when the main menu mounts a
signed-out sign-in slot**, not eagerly from `index.html`.

It is needed only to *sign in*. `resumeSession` presents our own token, so a returning signed-in
player — and anyone who lands straight back at a table — **never contacts Google at all**. With
guests first-class rather than degraded, not making every visitor load Google's script is worth
the brief empty slot.

**On failure — blocked, offline at load, Google down — the slot renders nothing.** No explanation.
The guest path is untouched, which is the whole point: Google down means sign-in down, never play
down.

Rejected: eager `async defer` in `index.html` (one line and GIS's documented shape, but Google
sees every visitor including guests who never tap); and an own-CSS button that loads the script on
tap (best privacy, but branding-compliance work and an extra hop before the popup).

## Three small things pinned

1. **Refusals, one code each:** `INVALID_CREDENTIAL` (the ID token failed verification) and
   `INVALID_SESSION` (expired or revoked). No enumeration concern — a `sub` is not guessable.
2. **The client ID is public by design and committed, not an environment variable.** One value
   read by both the button and the server's `aud` check, so the two cannot disagree. Home:
   `shared/src/config.ts`, a wire-contract fact both sides must agree on.
3. **No One Tap prompt on the main menu.** Button only; a guest is never nagged.
