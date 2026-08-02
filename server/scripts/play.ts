/**
 * Smoke-test harness for the game engine. No transport involved — this drives
 * RoomManager and the pure transitions directly, the same way the Socket.io layer
 * eventually will.
 *
 *   node scripts/play.ts                 auto-play a full match and print a transcript
 *   node scripts/play.ts --seed 7        same, with a specific seed (default: random)
 *   node scripts/play.ts --play          play as Ada against two bots
 *   node scripts/play.ts --players 4     change the table size (2-6)
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Card, DrawAction } from "@yaniv/shared";
import { sortHand } from "@yaniv/shared";
import { callYaniv, startGame, startNextRound, takeTurn } from "../src/game.ts";
import { RoomManager } from "../src/roomManager.ts";
import { mulberry32 } from "../src/rng.ts";
import { handValue, pickupCandidates } from "../src/rules.ts";
import { serializeStateForPlayer } from "../src/serialize.ts";
import type { GameState } from "../src/state.ts";
import { decideTurn } from "./bot.ts";

// --- rendering --------------------------------------------------------------

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

/** Pad to a visible width, ignoring the colour escapes that padEnd would miscount. */
function pad(text: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "").length;
  return text + " ".repeat(Math.max(0, width - visible));
}

function renderCard(card: Card): string {
  if (card.suit === null) return bold("Jk");
  const face = `${card.rank}${SUIT_SYMBOL[card.suit]}`;
  return card.suit === "hearts" || card.suit === "diamonds" ? red(face) : face;
}

const renderHand = (cards: readonly Card[]) => cards.map(renderCard).join(" ");

function nameOf(state: GameState, playerId: string): string {
  return state.players.find((p) => p.id === playerId)?.name ?? playerId;
}

// --- shared table state -----------------------------------------------------

interface Table {
  rooms: RoomManager;
  roomCode: string;
  humanId: string | null;
}

function setUp(playerCount: number, seed: number, human: boolean): Table {
  const names = ["Ada", "Grace", "Alan", "Edsger", "Barbara", "Tony"];
  const rooms = new RoomManager({
    rng: mulberry32(seed),
    newRoomRng: () => mulberry32(seed + 1),
  });

  const created = rooms.createRoom(names[0]!);
  if (!created.ok) throw new Error(created.error.message);
  const { roomCode, playerId } = created.value;

  for (let i = 1; i < playerCount; i++) {
    const joined = rooms.joinRoom(roomCode, names[i]!);
    if (!joined.ok) throw new Error(joined.error.message);
  }

  const started = rooms.apply(roomCode, (s, rng) => startGame(s, s.hostId, rng));
  if (!started.ok) throw new Error(started.error.message);

  return { rooms, roomCode, humanId: human ? playerId : null };
}

function printDeal(state: GameState): void {
  const round = state.round!;
  console.log(`\n${bold(`── Round ${state.roundNumber} ${"─".repeat(46)}`)}`);
  for (const id of round.turnOrder) {
    const hand = sortHand(round.hands[id]!);
    console.log(
      `  ${nameOf(state, id).padEnd(8)} ${renderHand(hand)}  ${dim(`(${handValue(hand)})`)}`,
    );
  }
  console.log(
    dim(
      `  table: ${renderHand(round.lastDiscard)}   deck: ${round.drawPile.length}\n`,
    ),
  );
}

function printRoundResult(state: GameState): void {
  const result = state.lastRoundResult!;
  const verdict =
    result.assaferId === null
      ? green("succeeds")
      : red(`ASSAF by ${nameOf(state, result.assaferId)}`);
  console.log(
    `\n  ${bold(nameOf(state, result.callerId))} calls ${cyan("YANIV")} — ${verdict}`,
  );
  for (const p of result.players) {
    const delta = p.delta === 0 ? green("  +0") : `${p.delta > 0 ? "+" : ""}${p.delta}`.padStart(4);
    console.log(
      `    ${pad(nameOf(state, p.playerId), 8)} ${pad(renderHand(sortHand(p.hand)), 22)} ` +
        dim(`${String(p.handValue).padStart(3)} `) +
        `${delta}  ${dim(`total ${p.scoreAfter}`)}`,
    );
  }
}

function printFinal(state: GameState): void {
  console.log(`\n${bold("══ Match over ══════════════════════════════════════")}`);
  const standings = [...state.players].sort((a, b) => a.score - b.score);
  for (const p of standings) {
    const isWinner = state.winnerIds?.includes(p.id);
    const line = `  ${p.name.padEnd(8)} ${String(p.score).padStart(4)}`;
    console.log(isWinner ? green(`${line}  ← winner`) : line);
  }
  console.log();
}

// --- auto mode --------------------------------------------------------------

function autoPlay(playerCount: number, seed: number): void {
  const { rooms, roomCode } = setUp(playerCount, seed, false);
  console.log(dim(`seed ${seed} · room ${roomCode} · ${playerCount} players`));
  printDeal(rooms.getState(roomCode)!);

  for (let step = 0; step < 20000; step++) {
    const state = rooms.getState(roomCode)!;

    if (state.phase === "gameEnd") return printFinal(state);
    if (state.phase === "roundEnd") {
      const next = rooms.apply(roomCode, (s, rng) => startNextRound(s, s.hostId, rng));
      if (!next.ok) throw new Error(next.error.message);
      printDeal(rooms.getState(roomCode)!);
      continue;
    }

    const round = state.round!;
    const playerId = round.currentTurnPlayerId;

    // The bot decides from the same view a client would receive, never raw state.
    const decision = decideTurn(serializeStateForPlayer(state, playerId));

    if (decision.type === "yaniv") {
      const called = rooms.apply(roomCode, (s) => callYaniv(s, playerId));
      if (!called.ok) throw new Error(called.error.message);
      printRoundResult(rooms.getState(roomCode)!);
      continue;
    }

    const { action } = decision;
    const before = handValue(round.hands[playerId]!);

    const result = rooms.apply(roomCode, (s, rng) =>
      takeTurn(s, playerId, action, rng),
    );
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);

    const next = rooms.getState(roomCode)!.round!;
    const after = next.hands[playerId]!;
    const draw = action.draw;
    const took =
      draw.source === "deck"
        ? dim("deck")
        : `table ${renderCard(
            round.lastDiscard.find((c) => c.id === draw.cardId)!,
          )}`;
    console.log(
      `  ${pad(nameOf(state, playerId), 8)} plays ` +
        // Show the canonical stored order, not the order the bot happened to submit.
        `${pad(renderHand(next.lastDiscard), 20)} ` +
        `draws ${pad(took, 12)} ${dim(`${before} → ${handValue(after)}`)}`,
    );
  }
  throw new Error("match did not finish");
}

// --- interactive mode -------------------------------------------------------

async function interactivePlay(playerCount: number, seed: number): Promise<void> {
  const { rooms, roomCode, humanId } = setUp(playerCount, seed, true);
  const rl = readline.createInterface({ input: stdin, output: stdout });

  /**
   * Ask a question, resolving to null once input is exhausted so Ctrl-D quits
   * cleanly. This pulls from the async line iterator rather than rl.question():
   * question() only captures a line if one arrives while it is pending, so piped
   * input (which readline delivers all at once) silently loses lines.
   */
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt: string): Promise<string | null> => {
    stdout.write(prompt);
    const next = await lines.next();
    return next.done ? null : next.value;
  };

  console.log(dim(`\nseed ${seed} · room ${roomCode} · you are Ada`));
  console.log(
    dim("commands: '1 3' to discard by number · 'yaniv' to call · 'q' to quit\n"),
  );

  try {
    for (let step = 0; step < 20000; step++) {
      const state = rooms.getState(roomCode)!;

      if (state.phase === "gameEnd") return printFinal(state);
      if (state.phase === "roundEnd") {
        if ((await ask(dim("  [enter] for the next round "))) === null) return;
        const next = rooms.apply(roomCode, (s, rng) => startNextRound(s, s.hostId, rng));
        if (!next.ok) throw new Error(next.error.message);
        continue;
      }

      const round = state.round!;
      const playerId = round.currentTurnPlayerId;

      if (playerId !== humanId) {
        const hand = sortHand(round.hands[playerId]!);
        // print the current bots hand (for debugging)
        console.log(
          `  ${nameOf(state, playerId).padEnd(8)} hand  ${hand.map((c, i) => `${dim(`${i + 1}:`)}${renderCard(c)}`).join("  ")}` +
            dim(`   = ${handValue(hand)}`),
        );
        const decision = decideTurn(serializeStateForPlayer(state, playerId));

        if (decision.type === "yaniv") {
          const called = rooms.apply(roomCode, (s) => callYaniv(s, playerId));
          if (!called.ok) throw new Error(called.error.message);
          printRoundResult(rooms.getState(roomCode)!);
          continue;
        }

        const played = rooms.apply(roomCode, (s, rng) =>
          takeTurn(s, playerId, decision.action, rng),
        );
        if (!played.ok) {
          throw new Error(`${played.error.code}: ${played.error.message}`);
        }
        console.log(
          `  ${dim(nameOf(state, playerId).padEnd(8))} plays ` +
            renderHand(rooms.getState(roomCode)!.round!.lastDiscard),
        );
        continue;
      }

      // Human turn. Sorted once: the same array backs both the rendering and the
      // by-number selection below, so an index can never point at a different card.
      const hand = sortHand(round.hands[humanId]!);
      console.log(bold("\n  your turn"));
      console.log(
        `  table ${renderHand(round.lastDiscard)}  ${dim(`deck ${round.drawPile.length}`)}`,
      );
      for (const p of state.players.filter((p) => p.id !== humanId)) {
        console.log(
          dim(`  ${p.name.padEnd(8)} ${round.hands[p.id]!.length} cards · ${p.score} pts`),
        );
      }
      console.log(
        `  hand  ${hand.map((c, i) => `${dim(`${i + 1}:`)}${renderCard(c)}`).join("  ")}` +
          dim(`   = ${handValue(hand)}`),
      );

      const raw = await ask("  discard > ");
      if (raw === null) return;
      const answer = raw.trim().toLowerCase();
      if (answer === "q") return;

      if (answer === "yaniv") {
        const called = rooms.apply(roomCode, (s) => callYaniv(s, humanId));
        if (!called.ok) {
          console.log(red(`  ✗ ${called.error.code}: ${called.error.message}`));
          continue;
        }
        printRoundResult(rooms.getState(roomCode)!);
        continue;
      }

      const picked = answer
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((token) => hand[Number(token) - 1]);
      if (picked.length === 0 || picked.some((c) => c === undefined)) {
        console.log(red("  ✗ pick cards by number, e.g. '1' or '2 3 4'"));
        continue;
      }
      const chosen = picked as Card[];

      const options = pickupCandidates(round.lastDiscard);
      const menu = options.map((c, i) => `${i + 1}:${renderCard(c)}`).join("  ");
      const rawDraw = await ask(`  draw — d:deck  ${menu} > `);
      if (rawDraw === null) return;
      const drawAnswer = rawDraw.trim().toLowerCase();

      let draw: DrawAction;
      if (drawAnswer === "d" || drawAnswer === "") {
        draw = { source: "deck" };
      } else {
        const option = options[Number(drawAnswer) - 1];
        if (!option) {
          console.log(red("  ✗ pick 'd' or one of the listed cards"));
          continue;
        }
        draw = { source: "discard", cardId: option.id };
      }

      const result = rooms.apply(roomCode, (s, rng) =>
        takeTurn(s, humanId, { discardCardIds: chosen.map((c) => c.id), draw }, rng),
      );
      if (!result.ok) {
        console.log(red(`  ✗ ${result.error.code}: ${result.error.message}`));
        continue;
      }
    }
  } finally {
    rl.close();
  }
}

// --- entry point ------------------------------------------------------------

function flagValue(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const seed = flagValue("--seed", Math.floor(Math.random() * 100000));
const playerCount = Math.min(6, Math.max(2, flagValue("--players", 3)));

if (process.argv.includes("--play")) {
  await interactivePlay(playerCount, seed);
} else {
  autoPlay(playerCount, seed);
}
