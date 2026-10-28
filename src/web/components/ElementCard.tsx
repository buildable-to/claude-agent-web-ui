// An element the agent found in the library (Buildable #942), as a card: its
// picture and words, View (a popup with its 3D outline and its sheet), Use
// and Make new — the engineer answers "this one, or a new one?" by clicking.
// The agent writes it as a link: [words](element:<id>).
import { Box, ExternalLink, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { parentOrigin, tellParent } from '@/lib/page';
import { sendText } from '@/lib/sendBus';

function urls(id: string) {
  const origin = parentOrigin();
  if (!origin) return null;
  const base = `${origin}/element-v4/saved/${encodeURIComponent(id)}`;
  return { thumb: `${base}/thumb.svg`, sheet: `${base}/sheet.png`, studio: `${base}/studio` };
}

function label(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(label).join('');
  return '';
}

export function ElementCard({ id, children }: { id: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [answered, setAnswered] = useState<null | 'use' | 'new'>(null);
  const words = label(children) || id;
  const [first, ...rest] = words.split(' · ');
  const title = first ?? id;
  const u = urls(id);
  // View: the studio opens the element over the whole page; a chat on its
  // own (no studio around it) shows its own small popup
  const view = () => {
    if (window.parent !== window && parentOrigin()) tellParent({ type: 'element', id, title });
    else setOpen(true);
  };
  const answer = (kind: 'use' | 'new') => {
    const ok = sendText(kind === 'use'
      ? `Use ${title} (element ${id}) — don't make a new one.`
      : `Make a new element — not ${title} (element ${id}).`);
    if (ok) setAnswered(kind);
  };
  return (
    <span className="element-card" data-element={id}>
      <button type="button" className="element-card-pic" onClick={view} title="View">
        {u ? <img src={u.thumb} alt="" loading="lazy" /> : <Box className="size-6" />}
      </button>
      <span className="element-card-words">
        <span className="element-card-title">{title}</span>
        {rest.length > 0 && <span className="element-card-facts">{rest.join(' · ')}</span>}
        <span className="element-card-actions">
          <button type="button" onClick={view}>View</button>
          <button type="button" className="primary" disabled={!!answered} onClick={() => answer('use')}>
            {answered === 'use' ? 'Using this' : 'Use'}
          </button>
          <button type="button" disabled={!!answered} onClick={() => answer('new')}>
            <Plus className="size-3" /> {answered === 'new' ? 'New asked' : 'Make new'}
          </button>
        </span>
      </span>
      {open && <ElementPopup id={id} title={title} facts={rest.join(' · ')} onClose={() => setOpen(false)} />}
    </span>
  );
}

function ElementPopup({ id, title, facts, onClose }: { id: string; title: string; facts: string; onClose: () => void }) {
  const u = urls(id);
  const [sheetFailed, setSheetFailed] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="lightbox rise" role="dialog" aria-modal="true" aria-label={title}
         onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <button type="button" className="lightbox-x" onClick={onClose} title="Close" aria-label="Close">
        <X className="size-4" />
      </button>
      <div className="element-popup">
        <div className="element-popup-head">
          <div>
            <div className="element-card-title">{title}</div>
            {facts && <div className="element-card-facts">{facts}</div>}
          </div>
          {u && (
            <a href={u.studio} target="_blank" rel="noopener noreferrer" className="element-popup-open">
              Open in Element Studio <ExternalLink className="size-3" />
            </a>
          )}
        </div>
        {u ? (
          <div className="element-popup-pics">
            <img className="element-popup-thumb" src={u.thumb} alt="3D outline" />
            {!sheetFailed && (
              <img className="element-popup-sheet" src={u.sheet} alt="its sheet" onError={() => setSheetFailed(true)} />
            )}
          </div>
        ) : (
          <p className="element-card-facts">Open this chat from the studio to see the element.</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
