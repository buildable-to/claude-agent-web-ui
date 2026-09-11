// The live side of 'looking at': the record the studio posts in, shared
// with every bubble through a context, and the one thing a view pill says
// back — frame this view over there.
import { createContext, useContext } from 'react';
import { tellParent } from './page';
import { parseLine, type Viewing } from './studio';

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
    type: 'highlight',
    mark: viewing.mark,
    view: viewKey,
    sheet: viewing.sheet?.kind ?? null,
  });
}

/** Say to the studio: frame what the chip names — the picked view when there
 *  is one, else light the piece up. The answer to 'what does it think I am
 *  looking at', one click. */
export function showViewing(viewing: Viewing | null) {
  if (!viewing || !viewing.mark) return;
  if (viewing.view) {
    showView(viewing.view.key, viewing);
    return;
  }
  tellParent({ type: 'highlight', mark: viewing.mark });
}

/** The transcript's grey line, clicked: it has only words — 'Looking at E1 ·
 *  Reinforcement · page 1 of 4 · VIEW FROM A [viewA]' — so the mark is the
 *  first part, the sheet the second (a label the studio resolves), the
 *  view's key the bracket at the end. A line about the whole project, or a
 *  GA sheet, names no piece to frame and does nothing. */
export function showLine(line: string) {
  const p = parseLine(line);
  if (!p) return;
  tellParent(p.view ? { type: 'highlight', mark: p.mark, view: p.view, sheet: p.sheet } : { type: 'highlight', mark: p.mark });
}
