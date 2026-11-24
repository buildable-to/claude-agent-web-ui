import { DEFAULT_MODEL, type ModelOption, type PermissionMode, type SessionMeta } from '@shared/protocol';
import { Menu } from './Menu';

export const MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: 'A classifier approves the routine commands; the live apply and the memory write still ask.' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'Scratch files go through; every command still asks (the live apply, the memory write).' },
  { value: 'default', label: 'Ask first', hint: 'Asks before edits and commands, like the terminal.' },
  { value: 'plan', label: 'Plan only', hint: 'Read-only. Claude plans but changes nothing.' },
  // No "Bypass all": on a shared server that would switch the gates off for
  // everyone who can reach the page. The terminal keeps it for throwaway work.
];

/** The engine reports a resolved id; the menu lists aliases. Match either. */
export function currentModel(meta: SessionMeta, models: ModelOption[]): ModelOption | undefined {
  const current = meta.model ?? '';
  return (
    models.find((m) => m.value === current || m.resolved === current) ??
    (current ? undefined : (models.find((m) => m.value === DEFAULT_MODEL) ?? models[0]))
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
  const align = look === 'pill' ? 'right' : 'left';     // pills hug the bar's right edge
  const modelItems = [
    ...(!match ? [{ value: '', label: current || 'Default model' }] : []),
    ...models.map((m) => ({ value: m.value, label: m.label, hint: m.description })),
  ];
  return (
    <>
      <Menu
        look={look}
        direction={direction}
        align={align}
        wide
        head="Model"
        title="Model"
        value={modelValue}
        onPick={(v) => onModel(v || null)}
        disabled={locked}
        items={modelItems}
      >
        {match ? match.label : current || 'Default model'}
      </Menu>
      <Menu
        look={look}
        direction={direction}
        align={align}
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
