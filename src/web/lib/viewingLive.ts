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

/** On the Elements tab the thing to point at is the element (or the draft)
 *  in the frame, by id — an element there may be unplaced, so no mark finds
 *  it. Off that tab it is the piece, by mark. Null: nothing to point at. */
function whom(viewing: Viewing): Record<string, unknown> | null {
  if (viewing.mode === 'element') {
    if (viewing.draft?.id) return { draft_id: viewing.draft.id };
    if (viewing.element?.id) return { element_id: viewing.element.id };
    return null;
  }
  return viewing.mark ? { mark: viewing.mark } : null;
}

/** Can the chip, or a pill made from this record, point at something? */
export function canShow(viewing: Viewing | null): boolean {
  return !!viewing && whom(viewing) !== null;
}

/** Say to the studio: open this piece's sheet and frame this view — or, on
 *  the Elements tab, frame it in the frame. The mark (or the element's id)
 *  and the sheet come off the record the pill was made from, so the studio
 *  is told exactly which paper the view is on. */
export function showView(viewKey: string, viewing: Viewing | null) {
  const who = viewing && whom(viewing);
  if (!who) return;
  tellParent({ type: 'highlight', ...who, view: viewKey, sheet: viewing?.sheet?.kind ?? null });
}

/** Say to the studio: frame what the chip names — the picked view when there
 *  is one, else light the piece (or point the Elements tab at the element)
 *  up. The answer to 'what does it think I am looking at', one click. */
export function showViewing(viewing: Viewing | null) {
  const who = viewing && whom(viewing);
  if (!who) return;
  if (viewing?.view) {
    showView(viewing.view.key, viewing);
    return;
  }
  tellParent({ type: 'highlight', ...who });
}

/** The transcript's grey line, clicked: it has only words — 'Looking at E1 ·
 *  Reinforcement · page 1 of 4 · VIEW FROM A [viewA]', or on the Elements
 *  tab '… · Element Studio · Formwork · SECTION A–A [a63b0f7e · formwork ·
 *  sec@400]' — so parseLine reads the mark or the element's id, the sheet
 *  and the view's key back off them. A line that names nothing to frame
 *  does nothing. */
export function showLine(line: string) {
  const p = parseLine(line);
  if (!p) return;
  const who = p.element_id ? { element_id: p.element_id } : { mark: p.mark };
  tellParent(p.view ? { type: 'highlight', ...who, view: p.view, sheet: p.sheet } : { type: 'highlight', ...who });
}
