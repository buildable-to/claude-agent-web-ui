// An element the agent found in the library (Buildable #942), as a library
// row: a framed outline, its name, one line of size. The row opens it (the
// studio shows its drawings over the page, with Use this); Use answers the
// agent here: the project places its own copy of it. The agent writes it as a link:
// [title · size · used](element:<id> "full name").
import { Box, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { parentOrigin, tellParent } from '@/lib/page';
import { answerElement, answerOf, knowElement, onAnswers } from '@/lib/sendBus';

function text(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(text).join('');
  return '';
}

export function ElementCard({ id, name, children }: { id: string; name?: string; children?: React.ReactNode }) {
  const [first, ...rest] = (text(children) || id).split(' · ');
  const title = first ?? id;
  const facts = rest.join(' · ');
  const [answer, setAnswer] = useState(answerOf(id));
  useEffect(() => {
    knowElement(id, title);
    return onAnswers(() => setAnswer(answerOf(id)));
  }, [id, title]);
  const origin = parentOrigin();
  const thumb = origin ? `${origin}/element-v4/saved/${encodeURIComponent(id)}/thumb.svg?view=side` : null;
  const open = () => {
    if (origin && window.parent !== window) tellParent({ type: 'element', id, title: name || title, facts });
    else if (origin) window.open(`${origin}/element-v4/saved/${encodeURIComponent(id)}/drawings`, '_blank');
  };
  return (
    <span className={`el-row ${answer ? `is-${answer}` : ''}`}>
      <button type="button" className="el-row-main" onClick={open} title={`${name || title} — open its drawings`}>
        <span className="el-row-pic">{thumb ? <img src={thumb} alt="" loading="lazy" /> : <Box className="size-4" />}</span>
        <span className="el-row-words">
          <span className="el-row-name">{title}</span>
          {facts && <span className="el-row-facts">{facts}</span>}
        </span>
      </button>
      {answer === 'use' ? (
        <span className="el-row-chosen"><Check className="size-3.5" /> Using</span>
      ) : (
        <span className="el-row-actions">
          <button type="button" className="use" onClick={() => answerElement(id, 'use')}>Use</button>
        </span>
      )}
    </span>
  );
}
