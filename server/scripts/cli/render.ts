/**
 * Turning a `PlayerGameView` into something a developer can read in a terminal.
 *
 * Pure: a view in, a string out. It knows nothing about sockets or stdout, so the
 * harness can render a frame without sending it anywhere — which is what lets the
 * session tests assert on what a developer would have seen.
 */

import type { PlayerGameView, RoundResultView } from "@yaniv/shared";
import { bold, cyan, dim, green, pad, red, renderCard, renderHand } from "../lib/cardDisplay.ts";

/** Wide enough for the seated bots, whose names carry a "(bot)" suffix. */
const NAME_WIDTH = 14;

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
    const marks = [id === view.hostId ? "(host)" : "", id === view.you.id ? "← you" : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(`  ${pad(byId.get(id)?.name ?? id, NAME_WIDTH)} ${dim(marks)}`);
  }

  lines.push(
    dim(
      view.hostId === view.you.id
        ? "  type start when everyone has joined"
        : "  waiting for the host to start",
    ),
  );
  return lines;
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
  return view.opponents.map((o) =>
    dim(`  ${o.name.padEnd(NAME_WIDTH)} ${o.handSize} cards · ${o.score} pts`),
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
function renderRoundResult(result: RoundResultView): string[] {
  const caller = result.players.find((p) => p.playerId === result.callerId);
  const assafer =
    result.assaferId === null
      ? null
      : result.players.find((p) => p.playerId === result.assaferId);

  const verdict = assafer === null ? green("succeeds") : red(`ASSAF by ${assafer?.name}`);
  const lines = [
    `\n  ${bold(caller?.name ?? result.callerId)} calls ${cyan("YANIV")} — ${verdict}`,
  ];

  for (const p of result.players) {
    const delta = `${p.delta > 0 ? "+" : ""}${p.delta}`.padStart(4);
    lines.push(
      `    ${p.name.padEnd(NAME_WIDTH)} ${pad(renderHand(p.hand), 22)} ` +
        dim(`${String(p.handValue).padStart(3)} `) +
        `${delta}  ${dim(`total ${p.scoreAfter}`)}`,
    );
  }
  return lines;
}

/** Final standings, lowest score first — in Yaniv, least is best. */
function renderStandings(view: PlayerGameView): string[] {
  const everyone = [view.you, ...view.opponents].sort((a, b) => a.score - b.score);
  const lines = [`\n${bold("══ Match over ══════════════════════════════════")}`];

  for (const p of everyone) {
    const line = `  ${p.name.padEnd(NAME_WIDTH)} ${String(p.score).padStart(4)}`;
    lines.push(view.winnerIds?.includes(p.id) ? green(`${line}  ← winner`) : line);
  }
  return lines;
}

export function renderView(view: PlayerGameView): string {
  if (view.phase === "lobby") return renderLobby(view).join("\n");

  if (view.phase === "gameEnd") {
    // Both: the round that ended it, then where everyone finished.
    const result = view.roundResult ? renderRoundResult(view.roundResult) : [];
    return [...result, ...renderStandings(view)].join("\n");
  }

  if (view.roundResult) return renderRoundResult(view.roundResult).join("\n");

  return [...renderOpponents(view), renderTable(view), renderOwnHand(view)].join(
    "\n",
  );
}
