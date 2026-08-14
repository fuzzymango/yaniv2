/** [PROTOTYPE — issue #56] Per-card rotation for an arced fan, hinge at the bottom center. */
export function fanAngles(n: number, maxSpreadDeg: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const spread = Math.min(maxSpreadDeg, n * 11);
  const step = spread / (n - 1);
  const start = -spread / 2;
  return Array.from({ length: n }, (_, i) => start + step * i);
}

/** Degrees the whole fan+label assembly turns to face the table's center, per zone. */
export const ZONE_ROTATION: Record<"left" | "top" | "right", number> = {
  left: -90,
  top: 180,
  right: 90,
};

/**
 * [PROTOTYPE — issue #56 — variant D] Corrected from `ZONE_ROTATION`: the fan's open,
 * spread edge points toward the felt and its hinge toward the screen edge — the opposite
 * of what A did. Only the fan rotates by this; D's labels stay upright in every zone.
 */
export const ZONE_ROTATION_FAN_D: Record<"left" | "top" | "right", number> = {
  left: 90,
  top: 180,
  right: -90,
};
