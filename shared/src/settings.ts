import { MAX_PLAYERS } from "./config.ts";

/** Every hand size a host may choose between — kept small enough that
 * `playerCount * handSize + 1 <= 54` can never be violated, even at `MAX_PLAYERS`.
 * docs/adr/0006. */
export const HAND_SIZES = [5, 6, 7] as const;

/** Every Yaniv-call threshold a host may choose between. docs/adr/0006. */
export const YANIV_THRESHOLDS = [3, 5, 7, 11] as const;

/* Derived from the lists rather than written out again beside them: a fifth option added
 * to one and not the other would otherwise typecheck, and the lobby renders from the same
 * lists the validator accepts. */
export type HandSize = (typeof HAND_SIZES)[number];
export type YanivThreshold = (typeof YANIV_THRESHOLDS)[number];

/**
 * A room's per-match configuration, host-chosen and locked at `startGame`.
 * docs/adr/0006.
 *
 * `botCount` is deliberately not stored clamped — a host can set it above what the
 * current human count leaves room for, and it is reevaluated wherever it's read
 * (`effectiveBotCount`) rather than rejected or re-validated on every join.
 */
export interface RoomSettings {
  handSize: HandSize;
  yanivThreshold: YanivThreshold;
  /** 1–100,000. Unlike `handSize`/`yanivThreshold`, free-form: no structural reason to
   * curate it. */
  maxScore: number;
  /** Within `BOT_COUNT_LIMITS`, and evaluated against the *current* human count at read
   * time — see `effectiveBotCount`. */
  botCount: number;
}

/** What a lobby's max-score control accepts, and the validator with it. */
export const MAX_SCORE_LIMITS = { min: 1, max: 100_000 } as const;

/**
 * What a lobby's bot-count control accepts. A room always seats the host who owns it, so
 * six bots is not a request that can mean anything — but anything up to that is legal
 * even when the current humans leave less room, since a stale count is read back down
 * where it is used (`effectiveBotCount`) rather than refused here. docs/adr/0006.
 */
export const BOT_COUNT_LIMITS = { min: 0, max: MAX_PLAYERS - 1 } as const;

/**
 * How many bot seats there are left to fill, given how many humans are seated — the most a
 * room could seat right now, whatever its settings ask for. Never negative, and never more
 * than a settings object is allowed to name.
 *
 * Here rather than in a lobby because it is the seating rule and not a display choice:
 * `effectiveBotCount` is this same number read against what the host asked for, and a
 * control offering the host their options is offering exactly these seats.
 */
export function botSeatLimit(humanCount: number): number {
  return Math.max(0, Math.min(BOT_COUNT_LIMITS.max, MAX_PLAYERS - humanCount));
}

/** How many bot seats `botCount` actually fills right now, given how many humans are
 * seated. A host who asked for more than there is room for gets what there is room for. */
export function effectiveBotCount(settings: RoomSettings, humanCount: number): number {
  return Math.max(0, Math.min(settings.botCount, botSeatLimit(humanCount)));
}

function isIntegerWithin(
  value: unknown,
  limits: { min: number; max: number },
): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= limits.min &&
    value <= limits.max
  );
}

/**
 * Whether an off-contract payload is a settings object at all: every field present, of
 * the right type, and inside its range or enum.
 *
 * Takes `unknown` deliberately. A `RoomSettings` off the wire is a claim by whoever sent
 * it, and the type says nothing about what actually arrived — the same reason a
 * client-supplied player id is never trusted. Shared so the lobby can offer exactly the
 * values this accepts rather than discovering the rule by being refused (ADR-0002).
 */
export function isValidSettings(value: unknown): value is RoomSettings {
  if (typeof value !== "object" || value === null) return false;
  const { handSize, yanivThreshold, maxScore, botCount } = value as Record<
    string,
    unknown
  >;
  return (
    HAND_SIZES.includes(handSize as HandSize) &&
    YANIV_THRESHOLDS.includes(yanivThreshold as YanivThreshold) &&
    isIntegerWithin(maxScore, MAX_SCORE_LIMITS) &&
    isIntegerWithin(botCount, BOT_COUNT_LIMITS)
  );
}
