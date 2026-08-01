import type { Card, TurnAction } from "@yaniv/shared";
import {
  ASSAF_PENALTY,
  HAND_SIZE,
  MAX_SCORE,
  MIN_PLAYERS,
  YANIV_THRESHOLD,
} from "./config.ts";
import { createDeck, deal, shuffle } from "./deck.ts";
import { err, ok } from "./result.ts";
import type { Rng } from "./rng.ts";
import {
  canonicalizeSet,
  handValue,
  isValidSet,
  pickupCandidates,
} from "./rules.ts";
import type {
  ActionResult,
  GameState,
  PlayerRoundResult,
  RoundResult,
  RoundState,
} from "./state.ts";
import { getPlayer } from "./state.ts";

// ---------------------------------------------------------------------------
// Starting rounds
// ---------------------------------------------------------------------------

/**
 * Build a completely fresh round. Every round-scoped field is set here and nowhere
 * else, so there is no way for a value to survive from the previous round.
 */
function dealRound(
  state: GameState,
  startingPlayerId: string,
  rng: Rng,
): GameState {
  const turnOrder = state.players.map((p) => p.id);
  const dealt = deal(shuffle(createDeck(), rng), turnOrder.length, HAND_SIZE);

  const hands: Record<string, Card[]> = {};
  turnOrder.forEach((playerId, index) => {
    hands[playerId] = dealt.hands[index]!;
  });

  const round: RoundState = {
    hands,
    drawPile: dealt.drawPile,
    lastDiscard: [dealt.firstDiscard],
    buried: [],
    currentTurnPlayerId: startingPlayerId,
    turnOrder,
  };

  return {
    ...state,
    phase: "playing",
    roundNumber: state.roundNumber + 1,
    round,
    lastRoundResult: null,
    winnerIds: null,
  };
}

/** Host starts the match from the lobby. The host takes the first turn. */
export function startGame(
  state: GameState,
  requesterId: string,
  rng: Rng,
): ActionResult {
  if (state.phase !== "lobby") {
    return err("WRONG_PHASE", "The game has already started");
  }
  if (requesterId !== state.hostId) {
    return err("NOT_HOST", "Only the host can start the game");
  }
  if (state.players.length < MIN_PLAYERS) {
    return err(
      "NOT_ENOUGH_PLAYERS",
      `Need at least ${MIN_PLAYERS} players to start`,
    );
  }
  return ok(dealRound(state, state.hostId, rng));
}

/** Host deals the next round. The previous round's winner takes the first turn. */
export function startNextRound(
  state: GameState,
  requesterId: string,
  rng: Rng,
): ActionResult {
  if (state.phase !== "roundEnd") {
    return err("WRONG_PHASE", "No finished round to advance from");
  }
  if (requesterId !== state.hostId) {
    return err("NOT_HOST", "Only the host can start the next round");
  }
  const starter = state.lastRoundResult?.winnerId ?? state.hostId;
  return ok(dealRound(state, starter, rng));
}

// ---------------------------------------------------------------------------
// Taking a turn
// ---------------------------------------------------------------------------

function nextPlayerId(round: RoundState): string {
  const index = round.turnOrder.indexOf(round.currentTurnPlayerId);
  return round.turnOrder[(index + 1) % round.turnOrder.length]!;
}

/** Resolve requested card ids against a hand, rejecting unknown or repeated ids. */
function collectFromHand(
  hand: readonly Card[],
  cardIds: readonly string[],
): { ok: true; cards: Card[] } | { ok: false; result: ActionResult } {
  if (cardIds.length === 0) {
    return { ok: false, result: err("EMPTY_DISCARD_SET", "Must discard at least one card") };
  }
  if (new Set(cardIds).size !== cardIds.length) {
    return { ok: false, result: err("DUPLICATE_CARDS", "Duplicate card in discard") };
  }

  const cards: Card[] = [];
  for (const id of cardIds) {
    const card = hand.find((c) => c.id === id);
    if (!card) {
      return {
        ok: false,
        result: err("CARD_NOT_IN_HAND", `Card ${id} is not in your hand`),
      };
    }
    cards.push(card);
  }
  return { ok: true, cards };
}

/**
 * A whole turn as one indivisible action: discard a valid set, then draw exactly one
 * card. There is deliberately no state in which a player has discarded but not drawn.
 *
 * Sequencing note: the pickup comes from the set that was on the table when this turn
 * began — the *previous* player's discard. Whatever is left of it becomes buried, and
 * this player's discard becomes the new `lastDiscard`. docs/rules.md §5.
 */
export function takeTurn(
  state: GameState,
  playerId: string,
  action: TurnAction,
  rng: Rng,
): ActionResult {
  if (state.phase !== "playing" || state.round === null) {
    return err("WRONG_PHASE", "No round in progress");
  }
  if (!getPlayer(state, playerId)) {
    return err("PLAYER_NOT_FOUND", "You are not in this game");
  }
  const round = state.round;
  if (round.currentTurnPlayerId !== playerId) {
    return err("NOT_YOUR_TURN", "It is not your turn");
  }

  const hand = round.hands[playerId] ?? [];

  const collected = collectFromHand(hand, action.discardCardIds);
  if (!collected.ok) return collected.result;
  if (!isValidSet(collected.cards)) {
    return err(
      "INVALID_SET",
      "Discard must be one card, a set of equal ranks, or a same-suit run of 3+ (jokers may fill gaps in a run)",
    );
  }

  // The pile as it stood at the start of this turn — the pickup source.
  const pickupSource = round.lastDiscard;
  let drawPile = round.drawPile;
  let buried = round.buried;
  let drawnCard: Card;
  let pickupLeftovers: Card[];

  if (action.draw.source === "deck") {
    if (drawPile.length === 0) {
      // Reshuffle the buried cards. The set currently on the table stays put.
      if (buried.length === 0) {
        return err("DECK_EXHAUSTED", "No cards left to draw");
      }
      drawPile = shuffle(buried, rng);
      buried = [];
    }
    drawnCard = drawPile[0]!;
    drawPile = drawPile.slice(1);
    pickupLeftovers = pickupSource;
  } else {
    if (pickupSource.length === 0) {
      return err("DISCARD_PILE_EMPTY", "There is nothing to pick up");
    }
    const wanted = action.draw.cardId;
    const eligible = pickupCandidates(pickupSource);
    const picked = eligible.find((c) => c.id === wanted);
    if (!picked) {
      return err(
        "CARD_NOT_PICKUP_ELIGIBLE",
        "Only the first or last card of the last discard can be taken",
      );
    }
    drawnCard = picked;
    pickupLeftovers = pickupSource.filter((c) => c.id !== wanted);
  }

  const discardedIds = new Set(action.discardCardIds);
  const newHand = [...hand.filter((c) => !discardedIds.has(c.id)), drawnCard];

  const newRound: RoundState = {
    ...round,
    hands: { ...round.hands, [playerId]: newHand },
    drawPile,
    buried: [...buried, ...pickupLeftovers],
    lastDiscard: canonicalizeSet(collected.cards),
    currentTurnPlayerId: nextPlayerId(round),
  };

  return ok({ ...state, round: newRound });
}

// ---------------------------------------------------------------------------
// Calling Yaniv and scoring
// ---------------------------------------------------------------------------

/**
 * Players other than the caller, ordered starting from the seat after the caller.
 * This ordering is the Assaf tie-break. docs/rules.md §6.
 */
function opponentsInTurnOrder(round: RoundState, callerId: string): string[] {
  const start = round.turnOrder.indexOf(callerId);
  const ordered: string[] = [];
  for (let i = 1; i < round.turnOrder.length; i++) {
    ordered.push(round.turnOrder[(start + i) % round.turnOrder.length]!);
  }
  return ordered;
}

/**
 * End the round. The caller scores 0 if unopposed; if any opponent is at or below the
 * caller's value it is an Assaf, and the caller takes their hand value + 30 while the
 * Assafer scores 0. docs/rules.md §6.
 */
export function callYaniv(state: GameState, playerId: string): ActionResult {
  if (state.phase !== "playing" || state.round === null) {
    return err("WRONG_PHASE", "No round in progress");
  }
  if (!getPlayer(state, playerId)) {
    return err("PLAYER_NOT_FOUND", "You are not in this game");
  }
  const round = state.round;
  if (round.currentTurnPlayerId !== playerId) {
    return err("NOT_YOUR_TURN", "It is not your turn");
  }

  const callerValue = handValue(round.hands[playerId] ?? []);
  if (callerValue > YANIV_THRESHOLD) {
    return err(
      "YANIV_THRESHOLD_NOT_MET",
      `Hand must be worth ${YANIV_THRESHOLD} or less to call Yaniv (yours is ${callerValue})`,
    );
  }

  const opponents = opponentsInTurnOrder(round, playerId);
  const values = new Map<string, number>();
  for (const id of round.turnOrder) {
    values.set(id, handValue(round.hands[id] ?? []));
  }

  // Ties favour the Assafer, so `<=`. Lowest value wins; the seat-order walk above
  // makes `find` a stable tie-break without a secondary sort.
  let assaferId: string | null = null;
  let bestValue = Number.POSITIVE_INFINITY;
  for (const id of opponents) {
    const value = values.get(id)!;
    if (value <= callerValue && value < bestValue) {
      assaferId = id;
      bestValue = value;
    }
  }

  const results: PlayerRoundResult[] = [];
  const scores = new Map(state.players.map((p) => [p.id, p.score]));

  for (const id of round.turnOrder) {
    const value = values.get(id)!;
    let delta: number;
    if (id === playerId) {
      delta = assaferId === null ? 0 : value + ASSAF_PENALTY;
    } else if (id === assaferId) {
      delta = 0;
    } else {
      delta = value;
    }
    const scoreAfter = scores.get(id)! + delta;
    scores.set(id, scoreAfter);
    results.push({
      playerId: id,
      hand: round.hands[id] ?? [],
      handValue: value,
      delta,
      scoreAfter,
    });
  }

  const roundResult: RoundResult = {
    roundNumber: state.roundNumber,
    callerId: playerId,
    assaferId,
    winnerId: assaferId ?? playerId,
    players: results,
  };

  const newPlayers = state.players.map((p) => ({
    ...p,
    score: scores.get(p.id)!,
  }));

  const busted = newPlayers.some((p) => p.score > MAX_SCORE);
  const lowest = Math.min(...newPlayers.map((p) => p.score));

  return ok({
    ...state,
    phase: busted ? "gameEnd" : "roundEnd",
    players: newPlayers,
    lastRoundResult: roundResult,
    winnerIds: busted
      ? newPlayers.filter((p) => p.score === lowest).map((p) => p.id)
      : null,
  });
}
