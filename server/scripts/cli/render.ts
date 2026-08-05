/**
 * Turning a `PlayerGameView` into something a developer can read in a terminal.
 *
 * Pure: a view in, a string out. It knows nothing about sockets or stdout, so the
 * harness can render a frame without sending it anywhere — which is what lets the
 * session tests assert on what a developer would have seen.
 */

import type { PlayerGameView, RoundResultView } from "@yaniv/shared";
import { standings } from "@yaniv/shared";
import { bold, cyan, dim, green, pad, red, renderCard, renderHand } from "../lib/cardDisplay.ts";

/** The narrowest a name column goes: wide enough for a bot's "(bot)"-suffixed name. */
const NAME_WIDTH = 14;

/**
 * How wide the name column has to be for the frame being rendered.
 *
 * A name is bounded — 20 characters server-side, plus at most " (you) (host)" added
 * here — but sizing every column to that worst case would leave an ordinary table of
 * short names trailing empty space. So a column takes the width of the longest name
 * actually on it, floored at `NAME_WIDTH` so the usual table looks as it always has.
 */
const columnWidth = (names: readonly string[]) =>
  Math.max(NAME_WIDTH, ...names.map((n) => n.length));

/**
 * The name a viewer reads for a seat, marked when the seat is one of theirs.
 *
 * "(bot)" arrives already baked into the name from the server, because a bot is a bot
 * whoever is looking. "(you)" can only be added here: who "you" is depends on which
 * screen the frame is bound for, so it is never stored or sent over the wire.
 *
 * `hostId` is passed only where being host is worth showing — the lobby, where starting
 * the match is the one thing a host does that nobody else can.
 */
function seatName(
  name: string,
  id: string,
  viewerId: string,
  hostId?: string,
): string {
  const marks = [id === viewerId ? "(you)" : "", id === hostId ? "(host)" : ""];
  return [name, ...marks.filter(Boolean)].join(" ");
}

/**
 * Said on both screens a player may leave from, in the same words, because leaving means
 * the same thing on both. What it costs the rest of the table is the server's decision
 * and depends on who is asking, so the line promises neither outcome.
 */
const EXIT_HINT = dim("  or menu to leave the room");

/** How a seat that has been given up is marked, wherever it is still worth listing. */
const DEPARTED = "(left)";

/**
 * An open lobby: the code to read aloud, who has arrived so far, and what happens next.
 *
 * Shares nothing with the mid-round frame — there is no hand, no table and no deck yet.
 * The host marker is display only; who may actually start is the server's call, and it
 * says so by rejecting anyone else with `NOT_HOST`.
 */
function renderLobby(view: PlayerGameView): string[] {
  const byId = new Map([view.you, ...view.opponents].map((p) => [p.id, p]));
  const lines = [`\n  ${bold(`room ${view.roomCode}`)}`];

  // Seating order, so every player's screen lists the table the same way round.
  for (const id of view.turnOrder) {
    const name = byId.get(id)?.name ?? id;
    lines.push(`  ${seatName(name, id, view.you.id, view.hostId)}`);
  }

  lines.push(
    dim(
      view.hostId === view.you.id
        ? "  type start when everyone has joined"
        : "  waiting for the host to start",
    ),
    EXIT_HINT,
  );
  return lines;
}

/**
 * What is left to do once a match is over: the host deals another, everyone else waits
 * on them. The same shape as the lobby's line, and for the same reason — who may replay
 * is the server's call, which answers anyone else with `NOT_HOST`.
 */
function renderGameEndOptions(view: PlayerGameView): string[] {
  return [
    dim(
      view.hostId === view.you.id
        ? "  type again for another match with this table"
        : "  waiting for the host to deal another match",
    ),
    EXIT_HINT,
  ];
}

/**
 * The viewer's hand, numbered for selection.
 *
 * The numbers index `view.you.hand` directly, which the serializer has already put in
 * display order. Rendering and selection therefore read the same array in the same
 * order, so a number can never point at a different card than the one printed.
 */
function renderOwnHand(view: PlayerGameView): string {
  const cards = view.you.hand
    .map((card, i) => `${dim(`${i + 1}:`)}${renderCard(card)}`)
    .join("  ");
  return `  hand  ${cards}`;
}

/** Opponents, one per line: what you know about them is a count and a score. */
function renderOpponents(view: PlayerGameView): string[] {
  const width = columnWidth(view.opponents.map((o) => o.name));
  return view.opponents.map((o) =>
    dim(`  ${o.name.padEnd(width)} ${o.handSize} cards · ${o.score} pts`),
  );
}

/** The face-up discard — also the pickup menu — and how much deck is left. */
function renderTable(view: PlayerGameView): string {
  return (
    `  table ${renderHand(view.lastDiscard)}  ` +
    dim(`deck ${view.drawPileCount}`)
  );
}

/**
 * A finished round: who called, whether it stood, and every hand face up.
 *
 * The hands come straight from the view — the server reveals them only at `roundEnd`
 * and `gameEnd`, so there is nothing here the harness has to decide about disclosure.
 */
function renderRoundResult(result: RoundResultView, viewerId: string): string[] {
  const named = (id: string) => {
    const player = result.players.find((p) => p.playerId === id);
    return seatName(player?.name ?? id, id, viewerId);
  };
  const verdict =
    result.assaferId === null
      ? green("succeeds")
      : red(`ASSAF by ${named(result.assaferId)}`);
  const lines = [
    `\n  ${bold(named(result.callerId))} calls ${cyan("YANIV")} — ${verdict}`,
  ];

  const rows = result.players.map((p) => ({
    ...p,
    name: seatName(p.name, p.playerId, viewerId),
  }));
  const width = columnWidth(rows.map((r) => r.name));

  for (const p of rows) {
    const delta = `${p.delta > 0 ? "+" : ""}${p.delta}`.padStart(4);
    lines.push(
      `    ${p.name.padEnd(width)} ${pad(renderHand(p.hand), 22)} ` +
        dim(`${String(p.handValue).padStart(3)} `) +
        `${delta}  ${dim(`total ${p.scoreAfter}`)}`,
    );
  }
  return lines;
}

/**
 * Final standings, lowest score first — in Yaniv, least is best.
 *
 * Who is on them, and in what order, is `standings` in `shared`: it is the same question
 * the browser client answers, and a match that is already over cannot be allowed to finish
 * two different ways depending on which client is looking. What is left here is the marks —
 * "(you)" depends on whose frame this is, and "(left)" on a seat given up since.
 */
function renderStandings(view: PlayerGameView): string[] {
  const rows = standings(view).map((p) => ({
    id: p.playerId,
    score: p.score,
    name: p.departed
      ? `${p.name} ${DEPARTED}`
      : seatName(p.name, p.playerId, view.you.id),
  }));
  const width = columnWidth(rows.map((r) => r.name));
  const lines = [`\n${bold("══ Match over ══════════════════════════════════")}`];

  for (const p of rows) {
    const line = `  ${p.name.padEnd(width)} ${String(p.score).padStart(4)}`;
    lines.push(view.winnerIds?.includes(p.id) ? green(`${line}  ← winner`) : line);
  }
  return lines;
}

/**
 * The screen before any room exists — no `PlayerGameView` to render, since there is no
 * game yet.
 */
export function renderMainMenu(): string {
  return [
    `\n  ${bold("yaniv")}`,
    dim("  create           start a new room"),
    dim("  join <code>      join a room by its code"),
    dim("  q                quit"),
  ].join("\n");
}

export function renderView(view: PlayerGameView): string {
  if (view.phase === "lobby") return renderLobby(view).join("\n");

  if (view.phase === "gameEnd") {
    // All three: the round that ended it, where everyone finished, and what is left to
    // do about it.
    const result = view.roundResult
      ? renderRoundResult(view.roundResult, view.you.id)
      : [];
    return [
      ...result,
      ...renderStandings(view),
      ...renderGameEndOptions(view),
    ].join("\n");
  }

  if (view.roundResult)
    return renderRoundResult(view.roundResult, view.you.id).join("\n");

  return [...renderOpponents(view), renderTable(view), renderOwnHand(view)].join(
    "\n",
  );
}
