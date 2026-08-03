/**
 * What a typed line means, given what is currently on screen.
 *
 * Pure and total: every input maps to a `Command`, including nonsense, which becomes
 * `invalid` with something to print. Nothing here throws — a mistyped line is the
 * normal case for a human at a prompt, not an exceptional one.
 *
 * Hand positions index `view.you.hand`, the same already-sorted array the renderer
 * numbers, so what the developer counted on screen is what gets discarded.
 */

import type { DrawAction, PlayerGameView, TurnAction } from "@yaniv/shared";
import { pickupCandidates } from "../../src/rules.ts";

export type Command =
  | { kind: "turn"; action: TurnAction }
  | { kind: "yaniv" }
  | { kind: "quit" }
  /** Begin the match. Only meaningful in the lobby, and only the host may do it. */
  | { kind: "start" }
  /** Deal the next round. What a bare enter means once a round has ended. */
  | { kind: "next" }
  /** Nothing to do; prompt again. */
  | { kind: "noop" }
  | { kind: "invalid"; message: string };

export function parseCommand(input: string, view: PlayerGameView): Command {
  const line = input.trim().toLowerCase();
  if (line === "q" || line === "quit") return { kind: "quit" };

  /**
   * In the lobby nobody holds a hand and nothing is on the table, so none of the card
   * commands below can mean anything: the one move available is the host's go-ahead.
   * Handled before them so a mistyped card command is turned down with advice that
   * applies, rather than being told to pick a card by number.
   *
   * Whether the typist is actually the host is not checked here — the server owns that,
   * and answers `NOT_HOST`. A second opinion in the harness could only ever disagree.
   */
  if (view.phase === "lobby") {
    if (line === "start") return { kind: "start" };
    if (line === "") return { kind: "noop" };
    return { kind: "invalid", message: "waiting in the lobby — 'start' begins the match" };
  }

  if (line === "yaniv") return { kind: "yaniv" };

  // A bare enter is the only input whose meaning depends on the phase: it deals the
  // next round when one has just ended, and is a stray keystroke otherwise.
  if (line === "") {
    return view.phase === "roundEnd" ? { kind: "next" } : { kind: "noop" };
  }

  const tokens = line.split(/[\s,]+/).filter(Boolean);

  // An optional trailing token says where the drawn card comes from: `d` for the deck
  // (also the default), `t<n>` for the nth face-up card on offer.
  let draw: DrawAction = { source: "deck" };
  const last = tokens.at(-1) ?? "";
  if (/^[dt]/.test(last)) {
    tokens.pop();
    if (last !== "d") {
      // The candidates come from the rulebook, not from re-deriving "first and last"
      // here — the harness must offer exactly what the server will accept.
      const options = pickupCandidates(view.lastDiscard);
      const chosen = options[Number(last.slice(1)) - 1];
      if (!chosen) {
        const menu = options.map((_, i) => `t${i + 1}`).join(" or ");
        return { kind: "invalid", message: `can only take ${menu} from the table` };
      }
      draw = { source: "discard", cardId: chosen.id };
    }
  }

  const picked = tokens.map((token) => view.you.hand[Number(token) - 1]);
  if (picked.some((card) => card === undefined)) {
    return { kind: "invalid", message: "pick cards by number, e.g. '1' or '2 3 4'" };
  }

  return {
    kind: "turn",
    action: { discardCardIds: picked.map((card) => card!.id), draw },
  };
}

export type MainMenuCommand =
  | { kind: "create" }
  | { kind: "join"; roomCode: string }
  | { kind: "quit" }
  | { kind: "noop" }
  | { kind: "invalid"; message: string };

/**
 * What a typed line means at the main menu — before any room exists, so unlike
 * `parseCommand` there is no view to read it against.
 */
export function parseMainMenuCommand(input: string): MainMenuCommand {
  const line = input.trim();
  const lower = line.toLowerCase();
  if (lower === "") return { kind: "noop" };
  if (lower === "q" || lower === "quit") return { kind: "quit" };
  if (lower === "create") return { kind: "create" };

  const joinMatch = line.match(/^join\s+(\S+)$/i);
  if (joinMatch) return { kind: "join", roomCode: joinMatch[1]! };

  return {
    kind: "invalid",
    message: "didn't understand that — try 'create', 'join <code>', or 'quit'",
  };
}
