// The live side of "looking at": the record the studio posts in, shared
// with every bubble through a context, and the one thing a view pill says
// back — frame this view over there.
import { createContext, useContext } from "react";
import { tellParent } from "./page";
import type { Viewing } from "./studio";

const ViewingContext = createContext<Viewing | null>(null);
export const ViewingProvider = ViewingContext.Provider;
export function useViewing(): Viewing | null {
  return useContext(ViewingContext);
}

/** Say to the studio: open this piece's sheet and frame this view. The
 *  mark and the sheet come off the record the pill was made from, so the
 *  studio is told exactly which paper the view is on. */
export function showView(viewKey: string, viewing: Viewing | null) {
  if (!viewing || !viewing.mark) return;
  tellParent({
    type: "highlight",
    mark: viewing.mark,
    view: viewKey,
    sheet: viewing.sheet?.kind ?? null,
  });
}
