// The live side of "@": the list the studio posts in, shared with every
// bubble through a context, and the one thing a pill says back.
import { createContext, useContext } from 'react';
import { EMPTY_MENTIONS, type MentionElement, type MentionMark, type Mentions } from './mentions';
import { parentOrigin, tellParent } from './page';

const MentionsContext = createContext<Mentions>(EMPTY_MENTIONS);
export const MentionsProvider = MentionsContext.Provider;
export function useMentions(): Mentions {
  return useContext(MentionsContext);
}

/** Say to the studio: light this mark's pieces up. */
export function highlight(mark: string) {
  tellParent({ type: 'highlight', mark });
}

/** Hear the studio's list. Only the page that embeds us is listened to. */
export function listenForMentions(onMentions: (m: Mentions) => void): () => void {
  const origin = parentOrigin();
  if (!origin) return () => {};
  const onMessage = (e: MessageEvent) => {
    if (e.origin !== origin) return;
    const d = e.data as { source?: string; type?: string; project?: unknown; marks?: unknown; library?: unknown } | null;
    if (!d || d.source !== 'buildable-studio' || d.type !== 'mentions') return;
    onMentions({
      project: typeof d.project === 'string' ? d.project : null,
      marks: Array.isArray(d.marks) ? (d.marks as MentionMark[]).filter((x) => x && typeof x.mark === 'string') : [],
      library: Array.isArray(d.library) ? (d.library as MentionElement[]).filter((x) => x && typeof x.id === 'string') : [],
    });
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
