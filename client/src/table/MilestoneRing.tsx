/**
 * The burst a milestone count begins with (spec #280): a laser ring traced once round the
 * counting seat's namecard — an opponent's label, or the viewer's own footer — or, under reduced
 * motion, a blue glow rising and falling on it instead.
 *
 * Decorative from end to end and `aria-hidden`: the line above the felt and the scorecard carry
 * the fact, as they do for the call banners. Drawn by `ScoredDetail` inside the namecard's own
 * box, which is positioned for it, so the ring is that box's outline and no other.
 *
 * **It measures nothing.** Every rect carries `pathLength="100"`, and the dashes are written as
 * unitless attributes in those units, so the browser turns `ringFrame`'s percentages into
 * lengths along whatever perimeter the namecard has — and `CardsInFlight.tsx` stays the one
 * module in this client that reads a rect off the page. The cost, accepted on the spec: the
 * head is a share of the perimeter, so it is longer on the long footer than on a seat label.
 *
 * Its geometry is attributes too — `width="100%"` on an SVG box inset by half the trail's
 * stroke — rather than CSS on the rect, which not every engine applies to SVG geometry: the
 * stroke runs centred on the SVG's edge, which is exactly the ring round the namecard.
 *
 * It has no clock of its own: `elapsedMs` is the table's one frame loop, and it is gone the
 * frame `ringFrame` says the fade is done. The glow is a CSS keyframe, its duration handed in as
 * a custom property; it is drawn only while the count is, and is over before it lands.
 */

import type { CSSProperties } from "react";
import type { RingStroke } from "../milestone.ts";
import { ringFrame } from "../milestone.ts";
import { MILESTONE_GLOW_MS } from "../timing.ts";

/** The rect's corner, round the namecard's own (0.5rem) out to the stroke's centre. */
const CORNER = 9.5;

/** One stroke of the ring, as a single dash along the namecard's perimeter. */
const along = ({ from, to }: RingStroke) => ({
  x: 0,
  y: 0,
  width: "100%",
  height: "100%",
  rx: CORNER,
  pathLength: 100,
  // A dash the stroke's length, then a gap longer than the whole lap, so it is drawn once.
  strokeDasharray: `${to - from} 200`,
  strokeDashoffset: -from,
});

export function MilestoneRing({ elapsedMs, still }: { elapsedMs: number; still: boolean }) {
  if (still) {
    return (
      <span
        className="milestone-glow"
        aria-hidden="true"
        style={{ "--milestone-glow": `${MILESTONE_GLOW_MS}ms` } as CSSProperties}
      />
    );
  }

  const frame = ringFrame(elapsedMs);
  if (frame === null) return null;
  return (
    <svg className="milestone-ring" style={{ opacity: frame.opacity }} aria-hidden="true">
      <g className="milestone-ring__trail">
        {frame.trail.map((segment, i) => (
          <rect
            key={i}
            {...along(segment)}
            opacity={segment.opacity}
            style={{
              stroke: `color-mix(in srgb, #fff ${segment.white * 100}%, var(--milestone))`,
            }}
          />
        ))}
      </g>
      {frame.head !== null && <rect className="milestone-ring__head" {...along(frame.head)} />}
    </svg>
  );
}
