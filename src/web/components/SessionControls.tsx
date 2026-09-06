import type { ModelOption, PermissionMode, SessionMeta } from '@shared/protocol';
import { Menu } from './Menu';

export const MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: 'A classifier approves the routine commands; the live apply and the memory write still ask.' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'Scratch files go through; every command still asks (the live apply, the memory write).' },
  { value: 'default', label: 'Ask first', hint: 'Asks before edits and commands, like the terminal.' },
  { value: 'plan', label: 'Plan only', hint: 'Read-only. Claude plans but changes nothing.' },
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
  const mode = meta.permissionMode ?? (embedded ? 'auto' : 'default');
  const direction = look === 'text' ? 'up' : 'down';   // the composer footer sits at the bottom
  const modelItems = [
    ...(!match ? [{ value: '', label: current || 'Default model' }] : []),
    ...models.map((m) => ({ value: m.value, label: modelLabel(m, look === 'text'), hint: m.description })),
  ];
  return (
    <>
      <Menu
        look={look}
        direction={direction}
        wide
        head="Model"
        title="Model"
        value={modelValue}
        onPick={(v) => onModel(v || null)}
        disabled={locked}
        items={modelItems}
      >
        {match ? modelLabel(match, look === 'text') : current || 'Default model'}
      </Menu>
      <Menu
        look={look}
        direction={direction}
        wide
        head="Before it acts"
        title={MODES.find((m) => m.value === mode)?.hint ?? 'Permission mode'}
        value={mode}
        onPick={(v) => onMode(v as PermissionMode)}
        disabled={locked}
        items={MODES.map((m) => ({ value: m.value, label: m.label, hint: m.hint }))}
      >
        {MODES.find((m) => m.value === mode)?.label ?? mode}
      </Menu>
    </>
  );
}
