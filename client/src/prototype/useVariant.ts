/** [PROTOTYPE — issue #56] Re-renders whenever the switcher changes `?variant=`. */

import { useSyncExternalStore } from "react";
import { readVariant, type VariantKey } from "./PrototypeSwitcher.tsx";

function subscribe(onChange: () => void) {
  window.addEventListener("prototype-variant-change", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("prototype-variant-change", onChange);
    window.removeEventListener("popstate", onChange);
  };
}

export function useVariant(): VariantKey {
  return useSyncExternalStore(subscribe, readVariant, readVariant);
}
