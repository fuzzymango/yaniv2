/**
 * Turning a `PlayerGameView` into something a developer can read in a terminal.
 *
 * Pure: a view in, a string out. It knows nothing about sockets or stdout, so the
 * harness can render a frame without sending it anywhere — which is what lets the
 * session tests assert on what a developer would have seen.
 */

import type { Card, PlayerGameView, RoundResultView } from "@yaniv/shared";

const SUIT_SYMBOL: Record<string, string> = {
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
  spades: "♠",
};

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

/** Wide enough for the seated bots, whose names carry a "(bot)" suffix. */
const NAME_WIDTH = 14;

/** Pad to a *visible* width — padEnd would miscount the colour escapes. */
function pad(text: string, width: number): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "").length;
  return text + " ".repeat(Math.max(0, width - visible));
}

export function renderCard(card: Card): string {
  if (card.suit === null) return bold("Jk");
  const face = `${card.rank}${SUIT_SYMBOL[card.suit]}`;
  return card.suit === "hearts" || card.suit === "diamonds" ? red(face) : face;
}

export const renderHand = (cards: readonly Card[]) =>
  cards.map(renderCard).join(" ");

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
