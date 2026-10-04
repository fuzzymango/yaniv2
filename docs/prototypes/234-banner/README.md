# PROTOTYPE — the call banner's shrink and wrap (#234)

Throwaway. Lives on `prototype/234-banner-shrink-wrap` and is never merged; the result is
recorded on issue #234 for #236 (the rule's cap) and #238 (the banner's styling).

**Question:** how small may the banner get, how many lines may it wrap to, and so what is the
longest custom call that fits at worst-case widths on a 360px phone?

## Running it

```sh
npm run serve:memory --workspace=@yaniv/server   # terminal 1
npm run dev --workspace=@yaniv/client            # terminal 2
```

Open `http://localhost:5173/?proto=banner`, start a match with 5 bots (the most cramped
table: two left seats, two top seats), and emulate a 360px phone. Every chosen seat gets a
frozen banner; the floating bar edits the text, worst-case presets, seats, step table
(`?steps=D` is the recommendation), line limit and width, and measures every banner on
screen (magenta = over the line limit or off the screen). `window.__setProto({...})` drives it
from devtools.

## Files

- `client/src/bannerPrototype.ts` — URL-backed config and the candidate step tables.
- `client/src/table/ProtoBanner.tsx` — the shipped banner's classes plus `announce--proto`.
- `client/src/table/BannerPrototypeBar.tsx` — the bar and its measurements.
- `client/src/styles.css` — the `PROTOTYPE #234` rules at the bottom.
- `client/src/table/Table.tsx`, `Seat.tsx` — `?proto=banner` gating.
- `docs/prototypes/234-banner/*.png` — the screenshots on the ticket.
