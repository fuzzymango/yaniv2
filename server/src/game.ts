import type { Card, TurnAction } from "@yaniv/shared";
import {
  ASSAF_PENALTY,
  MILESTONE_INTERVAL,
  MILESTONE_REDUCTION,
  MIN_PLAYERS,
  canCallYaniv,
  canonicalizeSet,
  handValue,
  isValidSet,
  isValidSettings,
  opensSlapdown,
  pickupCandidates,
} from "@yaniv/shared";
import { createDeck, deal, shuffle } from "./deck.ts";
import { err, ok } from "./result.ts";
import { randomInt, type Rng } from "./rng.ts";
import type {
  ActionResult,
  GameState,
  GameStateActive,
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
): GameStateActive {
  const turnOrder = state.players.map((p) => p.id);
  const dealt = deal(
    shuffle(createDeck(), rng),
    turnOrder.length,
    state.settings.handSize,
  );

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
    slapdown: null,
    lastMove: null,
    lastSlapdown: null,
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

/**
 * Who opens a brand new match: a seat drawn uniformly at random, never the host by
 * default — see ADR-0001. Rounds after the first are not chosen this way; the previous
 * round's winner opens those.
 */
function randomOpener(state: GameState, rng: Rng): string {
  return state.players[randomInt(rng, state.players.length)]!.id;
}

/**
 * The host starts the match from the lobby, but does not necessarily take the first
 * turn: the opening player is chosen uniformly at random from the seated players —
 * see ADR-0001.
 */
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
  // Meaningful again now `botCount` defaults to zero (docs/adr/0006): this used to run
  // against a table `seatBots` had already filled to six, so it could never fire. A
  // lone host who has asked for no bots is now correctly turned away, while one who has
  // asked for some is counted with them and plays.
  if (state.players.length < MIN_PLAYERS) {
    return err(
      "NOT_ENOUGH_PLAYERS",
      `Need at least ${MIN_PLAYERS} players to start`,
    );
  }
  return ok(dealRound(state, randomOpener(state, rng), rng));
}

/**
 * Replace the room's settings, all four fields at once. docs/adr/0006.
 *
 * Only from the lobby, and only by the host: `startGame` deals against these values and
 * every client's own legality check reads them, so a change once a round exists would be
 * a rule changed out from under a match already being played. There is no way back to the
 * lobby afterwards — `playAgain` deals directly from `gameEnd` — which is what makes the
 * first deal a lock for the life of the room rather than for one match.
 *
 * `settings` is `unknown` on purpose. It arrives off the wire, where the type is a claim
 * by whoever sent it rather than a fact, and `isValidSettings` is the only thing that
 * turns it into a `RoomSettings` — so an out-of-range field cannot reach the room by
 * being asserted into the right shape. All four land or none do: this rejects before it
 * builds a state, so there is no partial update to undo.
 *
 * The four fields are copied out rather than the object stored as it arrived. A payload
 * can be a valid `RoomSettings` and still carry more, and `settings` is published whole
 * to every player (`serializeStateForPlayer`) — so anything riding along would be kept by
 * the room and handed back out to the table.
 */
export function updateSettings(
  state: GameState,
  requesterId: string,
  settings: unknown,
): ActionResult {
  if (state.phase !== "lobby") {
    return err("WRONG_PHASE", "Settings are locked once the match has started");
  }
  if (requesterId !== state.hostId) {
    return err("NOT_HOST", "Only the host can change the room's settings");
  }
  if (!isValidSettings(settings)) {
    return err("INVALID_SETTINGS", "Those settings are not ones a room can be played on");
  }

  const { handSize, yanivThreshold, maxScore, botCount } = settings;
  return ok({ ...state, settings: { handSize, yanivThreshold, maxScore, botCount } });
}

/**
 * Restart the match in the same room, for whoever is still seated: scores and the round
 * number go back to zero and the first round is dealt on the spot, so there is no stop
 * in the lobby between one match and the next.
 *
 * Empty seats are deliberately not backfilled with bots — a seat given up by an exit to
 * the menu stays given up — so a table that has shrunk below the minimum is turned away
 * here exactly as `startGame` would turn it away.
 */
export function playAgain(
  state: GameState,
  requesterId: string,
  rng: Rng,
): ActionResult {
  if (state.phase !== "gameEnd") {
    return err("WRONG_PHASE", "No finished match to replay");
  }
  if (requesterId !== state.hostId) {
    return err("NOT_HOST", "Only the host can start another match");
  }
  if (state.players.length < MIN_PLAYERS) {
    // Said in terms of the table that is left rather than the lobby's "to start": whoever
    // reads this is looking at the standings of a match that has already been played, and
    // the seats it was played with are the thing that has since gone.
    return err(
      "NOT_ENOUGH_PLAYERS",
      `Too many players have left — another match needs at least ${MIN_PLAYERS}`,
    );
  }

  // Reset before dealing, so the fresh round is dealt against the fresh match: the
  // round number `dealRound` increments has to be the new match's, not the old one's.
  const fresh: GameState = {
    ...state,
    players: state.players.map((p) => ({ ...p, score: 0 })),
    roundNumber: 0,
  };
  return ok(dealRound(fresh, randomOpener(fresh, rng), rng));
}

/**
 * Take a player out of the room, freeing their seat for good — no bot moves into it.
 *
 * Only from the lobby or a finished match: leaving mid-round would abandon a hand and a
 * turn order that the round is still being played against, which is out of scope (see
 * CLAUDE.md's room lifecycle notes).
 *
 * The host is not special here. "The room must be destroyed" is not a `GameState` this
 * function could return, so that branch belongs to the layer that owns rooms — the same
 * way bot seating is a helper folded in around a transition rather than baked into one.
 */
export function removePlayer(state: GameState, playerId: string): ActionResult {
  if (state.phase !== "lobby" && state.phase !== "gameEnd") {
    return err("WRONG_PHASE", "You can only leave from the lobby or a finished match");
  }
  if (!getPlayer(state, playerId)) {
    return err("PLAYER_NOT_FOUND", "You are not in this game");
  }
  return ok({ ...state, players: state.players.filter((p) => p.id !== playerId) });
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
  if (state.phase !== "playing") {
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
    // Always assigned, never merged: whatever window the previous player was left with
    // closes here whether or not this turn opens one of its own. docs/rules.md §9.
    slapdown: opensSlapdown(collected.cards, action.draw.source, drawnCard)
      ? { playerId, card: drawnCard }
      : null,
    // Recorded here and nowhere else: this is the only transition that draws a card, and
    // the only place the identity of the drawn one is still known. What the serializer
    // then tells each viewer about it is a separate question.
    lastMove: { playerId, drawSource: action.draw.source, drawnCard },
  };

  return ok({ ...state, round: newRound });
}

/**
 * Put the card just drawn straight back down on the set it matches, out of turn.
 * docs/rules.md §9.
 *
 * Not a turn and not a variation on one: the turn moved to the next player the moment
 * the `takeTurn` that opened this window resolved, and it stays there. All this does is
 * shrink the slapper's hand by the card they never really got to keep.
 *
 * Whether the window is open is the whole of the rule — `takeTurn` already decided that
 * (`opensSlapdown`), and the next player's turn closes it — so there is nothing here to
 * ask about the cards. The card is guaranteed still in hand: its owner has not been able
 * to act since it was dealt to them, and whatever would have let them act closes the
 * window first.
 */
export function slapDown(state: GameState, playerId: string): ActionResult {
  if (state.phase !== "playing") {
    return err("WRONG_PHASE", "No round in progress");
  }
  const round = state.round;
  const window = round.slapdown;
  if (!window || window.playerId !== playerId) {
    return err("SLAPDOWN_NOT_AVAILABLE", "You have nothing to slap down");
  }

  const hand = round.hands[playerId] ?? [];

  const newRound: RoundState = {
    ...round,
    hands: { ...round.hands, [playerId]: hand.filter((c) => c.id !== window.card.id) },
    lastDiscard: [...round.lastDiscard, window.card],
    slapdown: null,
    // The slapdown's own fact, beside the card landing on the pile: which seat it came
    // out of is not otherwise recoverable, an open window being private to its holder.
    // `lastMove` is left standing — this is not a turn and records no draw. docs/adr/0008.
    lastSlapdown: { playerId, card: window.card },
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
  if (state.phase !== "playing") {
    return err("WRONG_PHASE", "No round in progress");
  }
  if (!getPlayer(state, playerId)) {
    return err("PLAYER_NOT_FOUND", "You are not in this game");
  }
  const round = state.round;
  if (round.currentTurnPlayerId !== playerId) {
    return err("NOT_YOUR_TURN", "It is not your turn");
  }

  const callerHand = round.hands[playerId] ?? [];
  const callerValue = handValue(callerHand);
  if (!canCallYaniv(callerHand, state.settings.yanivThreshold)) {
    return err(
      "YANIV_THRESHOLD_NOT_MET",
      `Hand must be worth ${state.settings.yanivThreshold} or less to call Yaniv (yours is ${callerValue})`,
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
    let scoreAfter = scores.get(id)! + delta;
    // The round winner (delta === 0) never re-triggers a reduction, even sitting on a
    // multiple already — a milestone is crossed, not merely occupied.
    const milestoneReduction =
      delta > 0 && scoreAfter % MILESTONE_INTERVAL === 0 ? MILESTONE_REDUCTION : 0;
    scoreAfter -= milestoneReduction;
    scores.set(id, scoreAfter);
    results.push({
      playerId: id,
      name: getPlayer(state, id)?.name ?? "",
      hand: round.hands[id] ?? [],
      handValue: value,
      delta,
      milestoneReduction,
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

  const busted = newPlayers.some((p) => p.score > state.settings.maxScore);
  const lowest = Math.min(...newPlayers.map((p) => p.score));

  return ok({
    ...state,
    phase: busted ? "gameEnd" : "roundEnd",
    // The call is the next player's turn, so it closes whatever window the previous one
    // was left holding — and a scored round has no out-of-turn move left in it anyway.
    round: { ...round, slapdown: null },
    players: newPlayers,
    lastRoundResult: roundResult,
    winnerIds: busted
      ? newPlayers.filter((p) => p.score === lowest).map((p) => p.id)
      : null,
  });
}
