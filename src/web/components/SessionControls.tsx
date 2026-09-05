import type { ModelOption, PermissionMode, SessionMeta } from '@shared/protocol';

export const MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'default', label: 'Ask first', hint: 'Asks before edits and commands, like the terminal.' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'Scratch files go through; every command still asks (the live apply, the memory write).' },
  { value: 'plan', label: 'Plan only', hint: 'Read-only. Claude plans but changes nothing.' },
  { value: 'auto', label: 'Auto', hint: 'A classifier decides what to allow.' },
  // No "Bypass all": on a shared server that would switch the gates off for
  // everyone who can reach the page. The terminal keeps it for throwaway work.
];

/** "Default (recommended)" says nothing about which model runs; name it:
 *  "Default · Opus 5 with 1M context" (the engine's own description, first
 *  part). In the composer footer the word "Default" is dropped — the footer
 *  is narrow and the model's own name says enough. */
export function modelLabel(m: ModelOption, short = false): string {
  if (m.value !== 'default' || !m.description) return m.label;
  const what = m.description.split(' · ')[0]?.trim();
  if (!what) return m.label;
  return short ? what : `Default · ${what}`;
}

/** The engine reports a resolved id; the menu lists aliases. Match either. */
export function currentModel(meta: SessionMeta, models: ModelOption[]): ModelOption | undefined {
  const current = meta.model ?? '';
  return (
    models.find((m) => m.value === current || m.resolved === current) ??
    (current ? undefined : (models.find((m) => m.value === 'default') ?? models[0]))
  );
}

export type ControlsProps = {
  meta: SessionMeta;
  models: ModelOption[];
  /** No changes while the engine is still attaching. */
  locked: boolean;
  /** Embedded for engineers: only the modes where every command still asks;
   *  "Auto" would let a classifier wave a live apply through. */
  embedded?: boolean;
  /** `pill` in the standalone top bar; `text` in the composer footer, where
   *  the pickers read as words with a caret rather than as controls. */
  look: 'pill' | 'text';
  onModel: (model: string | null) => void;
  onMode: (mode: PermissionMode) => void;
};

/** The two pickers a conversation carries: which model, which permission mode. */
export function SessionControls({ meta, models, locked, embedded = false, look, onModel, onMode }: ControlsProps) {
  const match = currentModel(meta, models);
  const modelValue = match?.value ?? '';
  const current = meta.model ?? '';
  const cls = look === 'pill' ? 'pill' : 'textsel';
  const mode = meta.permissionMode ?? (embedded ? 'acceptEdits' : 'default');
  return (
    <>
      <select className={cls} value={modelValue} onChange={(e) => onModel(e.target.value || null)} disabled={locked} title="Model">
        {!match && <option value="">{current || 'Default model'}</option>}
        {models.map((m) => (
          <option key={m.value} value={m.value} title={m.description}>
            {modelLabel(m, look === 'text')}
          </option>
        ))}
      </select>
      <select
        className={cls}
        value={mode}
        onChange={(e) => onMode(e.target.value as PermissionMode)}
        disabled={locked}
        title={MODES.find((m) => m.value === mode)?.hint ?? 'Permission mode'}
      >
        {MODES.filter((m) => !embedded || m.value !== 'auto').map((m) => (
          <option key={m.value} value={m.value} title={m.hint}>
            {m.label}
          </option>
        ))}
      </select>
    </>
  );
}
