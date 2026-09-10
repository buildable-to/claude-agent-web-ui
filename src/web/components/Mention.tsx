// A mark in a sentence, as a pill. Click: the studio lights its pieces up.
import { mentionLabel } from '@/lib/mentions';
import { highlight, useMentions } from '@/lib/mentionsLive';

export function Mention({ token, light }: { token: string; light?: boolean }) {
  const mentions = useMentions();
  const { label, title, mark } = mentionLabel(token, mentions);
  return (
    <button
      type="button"
      className={`mention ${light ? 'light' : ''}`}
      title={title}
      onClick={() => (mark ? highlight(mark) : undefined)}
      disabled={!mark}
    >
      {label}
    </button>
  );
}
