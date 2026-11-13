# yaniv2

Multiplayer [Yaniv](https://en.wikipedia.org/wiki/Yaniv_(card_game)), built top-down:
engine first, fully unit tested, then transport. TypeScript, npm workspaces. The server has
three runtime dependencies and nothing else does — `socket.io`, `postgres` for the profile
store (`docs/adr/0019`) and `google-auth-library` to verify a sign-in (`docs/adr/0020`), each of
the last two imported by exactly one file.
`shared/` is types, the event contract and the rulebook, so it stays dependency-free for the
client's sake.

# behavior rules
This section bullet points specific behavior patterns that you should follow when working in this repository. Do not modify this section.

- **keep `README.md` and `CLAUDE.md` updated** - after implementing code changes, review the contents of `CLAUDE.md` and README.md and ensure they're kept up to date and relevant with the current state of the codebase. For example, if you add or modify an `npm run ...` command, ensure that the `README.md` is amended to reflect this change. Developers will look at `README.md` often and we don't want to have false/stale information present. The catch to ths is, we don't want `README.md` to become bloated with information so only maintain the high-level information necessary for navigating this project. The `CLAUDE.md` file should be no more than 700 lines. If the document exeeds 700 lines, compact it by:

- **Trim non-universal instructions:** Remove details Claude can easily discover by inspecting your file tree or code patterns.
- **Delete redundant history:** Purge old to-do lists, outdated implementation notes, and completed session logs.
- **Use sub-file references:** Move specific architectural breakdowns or deep-dive documentation into external files (ADRs or `README.md`) and reference them lightly instead of pasting text inline.

## Where the rules live

**`docs/rules.md` is the single source of truth for gameplay.** Every rule maps to at least one
test; if code and `rules.md` disagree, `rules.md` is right and the code has a bug. Adding or
changing a rule goes `docs/rules.md` first, then the code, then tests — never let a rule exist
only in code. `docs/backend-archetechture.md` is the original design sketch, **stale** in
several places, kept for history only: what it describes and you cannot find is one of the
deviations listed at the top of that file, each with its reasoning below.

The rest of `docs/`, in the order you are likely to want it: `code-map.md` (every file in the
four source trees), `adr/` (one decision each, numbered), `client-table.md` (the felt) and
`client-session.md` (the wire behind it). `CONTEXT.md` at the root is the domain vocabulary.

Code structure, the key decisions and what is out of scope now live in `docs/architecture.md`.

## Running things

```sh
npm test                                         # all workspaces, node:test
npm run typecheck                                # tsc --build across the monorepo
npm run serve:memory --workspace=@yaniv/server   # the socket server, profiles in memory
npm run serve --workspace=@yaniv/server          # the same, against DATABASE_URL (PORT, 3000)
```

Every command and flag is tabulated in `README.md`. One thing to know before reading it: the
browser client (`npm run dev`) and the CLI harness (`npm run play`) are each real clients of a
**separately running server**, so both take a second terminal running `npm run serve:memory`.
Deployment is one Railway service serving both halves, plus the Postgres service behind it
(`docs/adr/0003`, `docs/adr/0019`).

## Agent skills

- **Issue tracker** — GitHub Issues (`fuzzymango/yaniv2`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.
- **Domain docs** — single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
