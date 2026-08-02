import type { GameError, GameErrorCode } from "@yaniv/shared";

/**
 * Every action that can be rejected returns one of these instead of throwing.
 * TypeScript then forces each call site to handle the failure branch.
 *
 * Anything that throws from this codebase is a genuine defect, and the socket layer
 * should let it propagate rather than reporting it to the player as a rule violation.
 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: GameError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(
  code: GameErrorCode,
  message: string,
): Result<T> {
  return { ok: false, error: { code, message } };
}
