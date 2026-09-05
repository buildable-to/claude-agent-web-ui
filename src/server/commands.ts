// Discover the slash commands / skills the engine accepts for a project
// without sending it a message: spawn it, read the initialize reply, stop.
import {
  query,
  type ModelInfo,
  type SDKUserMessage,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandInfo, EngineInfo, ModelOption } from '../shared/protocol.js';

export function toModelOptions(models: ModelInfo[]): ModelOption[] {
  return models.map((m) => ({
    value: m.value,
    label: m.displayName,
    description: m.description,
    ...(m.resolvedModel ? { resolved: m.resolvedModel } : {}),
  }));
}

/**
 * The commands the composer offers. `only` (a set of names) narrows the list
 * to those: on Buildable's shared server the skills installed for the agent,
 * not Claude Code's own /usage, /compact, /config.
 */
export function toCommandInfo(
  commands: SlashCommand[],
  terminalOnly: string[] = [],
  only: ReadonlySet<string> | null = null,
): CommandInfo[] {
  const hide = new Set(terminalOnly.map((n) => n.replace(/^\//, '')));
  const seen = new Set<string>();
  const out: CommandInfo[] = [];
  for (const c of commands) {
    const name = c.name.replace(/^\//, '');
    if (!name || hide.has(name) || seen.has(name)) continue;
    if (only && !only.has(name)) continue;
    // internal plumbing and tombstones
    if (name.startsWith('__') || /^\(removed\)/i.test(c.description ?? '')) continue;
    seen.add(name);
    out.push({
      name,
      description: c.description ?? '',
      ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Names of the skills installed under each dir: `<dir>/.claude/skills/<folder>/SKILL.md`,
 * named by the frontmatter `name:` when there is one, else the folder (as Claude Code does).
 * Dirs without skills are skipped.
 */
export async function installedSkills(dirs: string[]): Promise<Set<string>> {
  const names = new Set<string>();
  for (const dir of dirs) {
    const root = join(dir, '.claude', 'skills');
    let folders: string[];
    try {
      folders = await readdir(root);
    } catch {
      continue;
    }
    for (const folder of folders) {
      let text: string;
      try {
        text = await readFile(join(root, folder, 'SKILL.md'), 'utf8');
      } catch {
        continue;
      }
      const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
      const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim().replace(/^["']|["']$/g, '');
      names.add(name || folder);
    }
  }
  return names;
}

const never: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
};

export async function probeEngine(
  cwd: string,
  only: ReadonlySet<string> | null = null,
  timeoutMs = 25_000,
): Promise<EngineInfo> {
  const abort = new AbortController();
  const q = query({
    prompt: never,
    options: {
      cwd,
      abortController: abort,
      persistSession: false,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      canUseTool: async () => ({ behavior: 'deny', message: 'probe' }),
      stderr: () => undefined,
    },
  });
  let terminalOnly: string[] = [];
  const pump = (async () => {
    try {
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') terminalOnly = m.terminal_slash_commands ?? [];
      }
    } catch {
      // aborted
    }
  })();
  try {
    const init = await Promise.race([
      q.initializationResult(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('engine did not initialize in time')), timeoutMs)),
    ]);
    return { commands: toCommandInfo(init.commands, terminalOnly, only), models: toModelOptions(init.models) };
  } finally {
    abort.abort();
    await pump;
  }
}
