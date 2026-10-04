/**
 * PROTOTYPE — issue #234. Throwaway, never merged.
 *
 * Today's `CallAnnouncement`, frozen fully shown, carrying the prototype's text and sized by
 * the shrink step its length selects. Same classes as the real banner, so weight,
 * letter-spacing, colour, stroke and side-seat anchoring are the shipped ones; only the
 * `announce--proto` overrides (font scale, wrap, max width, no animation) are new.
 */

import type { CSSProperties } from "react";
import { stepFor, useProto } from "../bannerPrototype.ts";

export function ProtoBanner() {
  const proto = useProto();
  const said = proto.text.trim().toLocaleUpperCase();
  const scale = stepFor(proto.steps, said.length);
  return (
    <span
      className={`announce announce--${proto.kind} announce--proto`}
      aria-hidden="true"
      data-proto-lines={proto.lines}
      style={
        {
          "--announce-scale": scale,
          "--announce-width": `${proto.width}vw`,
        } as CSSProperties
      }
    >
      {said}
    </span>
  );
}
