// An element the agent found in the library (Buildable #942), as a small
// picture card: its outline, a short name, one line of size. The picture
// opens it (the studio shows it over the page, on its drawings); Use and New
// answer the agent as typed words. The agent writes it as a link:
// [title · size · used](element:<id> "full name").
import { Box, Check, Plus } from 'lucide-react';
import { useState } from 'react';
import { parentOrigin, tellParent } from '@/lib/page';
import { sendText } from '@/lib/sendBus';

function text(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(text).join('');
  return '';
}

export function ElementCard({ id, name, children }: { id: string; name?: string; children?: React.ReactNode }) {
  const [answered, setAnswered] = useState<null | 'use' | 'new'>(null);
  const [first, ...rest] = (text(children) || id).split(' · ');
  const title = first ?? id;
  const facts = rest.join(' · ');
  const origin = parentOrigin();
  const thumb = origin ? `${origin}/element-v4/saved/${encodeURIComponent(id)}/thumb.svg` : null;
  const open = () => {
    if (origin && window.parent !== window) tellParent({ type: 'element', id, title: name || title });
    else if (origin) window.open(`${origin}/element-v4/saved/${encodeURIComponent(id)}/studio?open=drawings`, '_blank');
  };
  const answer = (kind: 'use' | 'new') => {
    const ok = sendText(kind === 'use'
      ? `Use ${title} (element ${id}).`
      : `Make a new element instead of ${title} (element ${id}).`);
    if (ok) setAnswered(kind);
  };
  return (
    <span className={`el-card ${answered ? `is-${answered}` : ''}`} title={name || title}>
      <button type="button" className="el-card-pic" onClick={open} aria-label={`Open ${title}`}>
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <Box className="size-6" />}
        <span className="el-card-open">Open</span>
      </button>
      <span className="el-card-name">{title}</span>
      {facts && <span className="el-card-facts">{facts}</span>}
      <span className="el-card-actions">
        <button type="button" className="use" disabled={!!answered} onClick={() => answer('use')}>
          {answered === 'use' ? <><Check className="size-3" /> Using</> : 'Use'}
        </button>
        <button type="button" disabled={!!answered} onClick={() => answer('new')} title="Make a new element instead">
          <Plus className="size-3" /> New
        </button>
      </span>
    </span>
  );
}
