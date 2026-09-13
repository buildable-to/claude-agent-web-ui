// A short chime when the agent stops for the engineer: an approve card or a
// question card has come up. The tab title and the icon already say "Needs
// you"; this says it to an engineer whose eyes are on the 3D, not on the
// panel. Two notes from the Web Audio API — nothing to load.
//
// A browser keeps a page silent until the person has clicked or typed on it,
// so the first gesture in the panel warms the audio (`armChime`); a chime the
// browser still refuses is dropped without a word — the title and the icon
// carry it.

import type { SessionStatus } from '@shared/protocol';

type Status = SessionStatus | 'connecting';

/** A card came up during a live turn: sound it. A card found on arrival
 *  (attach replays a pending one when the page opens or a conversation is
 *  picked) is not news, so `connecting` and `idle` before it stay quiet.
 *  Status alone: a second card queued behind the first keeps the status and
 *  does not sound again — the engineer is already there, answering. */
export function shouldChime(prev: Status, next: Status): boolean {
  return next === 'requires_action' && (prev === 'running' || prev === 'starting');
}

const KEY = 'chime';

/** On unless the person turned it off in this browser. */
export function readChimeOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeChimeOn(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return null;
  try {
    ctx = new window.AudioContext();
  } catch {
    return null;
  }
  return ctx;
}

let armed = false;

/** The first click or key in the page is the gesture the browser wants
 *  before it lets the page sound; use it to wake the audio, so a chime later
 *  needs no gesture of its own. Idempotent. */
export function armChime(): void {
  if (armed || typeof document === 'undefined') return;
  armed = true;
  const warm = () => {
    const c = context();
    if (c && c.state === 'suspended') c.resume().catch(() => undefined);
  };
  document.addEventListener('pointerdown', warm, { passive: true });
  document.addEventListener('keydown', warm, { passive: true });
}

/** Two soft rising notes, a third of a second. Silent when the browser has
 *  not yet let the page sound. */
export function chime(): void {
  const c = context();
  if (!c) return;
  const play = () => {
    const at = c.currentTime;
    const note = (hz: number, start: number, len: number) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0, at + start);
      gain.gain.linearRampToValueAtTime(0.18, at + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0008, at + start + len);
      osc.connect(gain).connect(c.destination);
      osc.start(at + start);
      osc.stop(at + start + len + 0.02);
    };
    note(880, 0, 0.22); // A5
    note(1318.5, 0.13, 0.3); // E6
  };
  if (c.state === 'running') {
    play();
    return;
  }
  c.resume()
    .then(() => {
      if (c.state === 'running') play();
    })
    .catch(() => undefined);
}
