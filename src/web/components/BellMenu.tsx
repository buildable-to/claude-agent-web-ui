// The bell under the composer, embedded in a studio (ezdxf-flask #1203):
// notifications on/off, the sound on/off, and a test. The studio around the
// chat shows the notifications (a browser asks permission of the top page
// only); this menu only says what the engineer chose.
import { Bell, BellOff, Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type Props = {
  notify: boolean;
  sound: boolean;
  onNotify: () => void;
  onSound: () => void;
  onTest: () => void;
};

export function BellMenu({ notify, sound, onNotify, onSound, onTest }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const row = (label: string, on: boolean | null, act: () => void) => (
    <button
      type="button"
      role={on === null ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={on === null ? undefined : on}
      onClick={() => {
        act();
        if (on === null) setOpen(false);
      }}
      className="menu-item"
    >
      <span className="menu-check">{on && <Check className="size-3.5" strokeWidth={2.5} />}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
  return (
    <div ref={root} className="relative inline-block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Notifications"
        title={notify ? 'Notifications on — click for the settings' : 'Notifications off — click for the settings'}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-7 items-center rounded-md px-2 hover:bg-panel-2 hover:text-ink ${notify ? 'text-ink-2' : 'text-ink-3'}`}
      >
        {notify ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
      </button>
      {open && (
        <div role="menu" className="menu-pop rise absolute bottom-full left-0 z-30 mb-1.5 min-w-[13rem]">
          {row('Notifications', notify, onNotify)}
          {row('Sound', sound, onSound)}
          {row('Send a test notification', null, onTest)}
        </div>
      )}
    </div>
  );
}
