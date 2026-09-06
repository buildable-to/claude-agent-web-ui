// A picture the agent looked at, opened over everything: the studio behind
// it dims, the picture takes the screen, its name sits under it. Escape, a
// click outside or the cross closes; arrows walk the pictures of one step.
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ToolImage } from '@/lib/transcript';

export type LightboxPicture = { image: ToolImage; caption?: string };

type Props = {
  pictures: LightboxPicture[];
  index: number;
  onClose: () => void;
};

export function Lightbox({ pictures, index, onClose }: Props) {
  const [i, setI] = useState(index);
  const n = pictures.length;
  const step = (d: number) => setI((k) => (k + d + n) % n);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key === 'ArrowRight' && n > 1) { e.preventDefault(); step(1); }
      if (e.key === 'ArrowLeft' && n > 1) { e.preventDefault(); step(-1); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, onClose]);

  const p = pictures[i];
  if (!p) return null;
  return createPortal(
    <div
      className="lightbox rise"
      role="dialog"
      aria-modal="true"
      aria-label={p.caption ?? 'picture'}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <button type="button" className="lightbox-x" onClick={onClose} title="Close" aria-label="Close">
        <X className="size-4" />
      </button>
      {n > 1 && (
        <button type="button" className="lightbox-nav left" onClick={() => step(-1)} title="Previous" aria-label="Previous">
          <ChevronLeft className="size-5" />
        </button>
      )}
      <figure className="lightbox-fig">
        <img src={`data:${p.image.mediaType};base64,${p.image.data}`} alt={p.caption ?? 'picture'} />
        <figcaption>
          {p.caption}
          {n > 1 && <span className="lightbox-count">{i + 1} / {n}</span>}
        </figcaption>
      </figure>
      {n > 1 && (
        <button type="button" className="lightbox-nav right" onClick={() => step(1)} title="Next" aria-label="Next">
          <ChevronRight className="size-5" />
        </button>
      )}
    </div>,
    document.body,
  );
}
