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
