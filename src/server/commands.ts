// Discover the slash commands / skills the engine accepts for a project
// without sending it a message: spawn it, read the initialize reply, stop.
import {
  query,
  type ModelInfo,
  type SDKUserMessage,
  type SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandInfo, EngineInfo, ModelOption } from '../shared/protocol.js';

/**
 * The engine lists its aliases (default, opus, sonnet, ...) and then older
 * pinned versions (claude-opus-4-8, ...). The picker offers the aliases only,
 * and not the one that names the same model as Default.
 */
export function toModelOptions(models: ModelInfo[]): ModelOption[] {
  const byDefault = models.find((m) => m.value === 'default')?.resolvedModel;
  const current = models.filter(
    (m) =>
      !m.value.startsWith('claude-') &&
      (m.value === 'default' || !byDefault || m.resolvedModel !== byDefault),
  );
  return current.map((m) => ({
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

/** Claude Code's home for the engines this service starts: CLAUDE_CONFIG_DIR
 *  (a laptop's agent home) or ~/.claude (the agent user's, on the server). */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

/**
 * The skills installed under each Claude dir: `<dir>/skills/<folder>/SKILL.md`,
 * named by the frontmatter `name:` when there is one, else the folder (as
 * Claude Code does), with the frontmatter's `description:`. Dirs without
 * skills are skipped. `noLinks`: an account's folder, where its agent writes —
 * a link anywhere on the way (`.claude/skills` pointing at another account's)
 * is skipped, never followed.
 */
export async function skillCommands(dirs: string[], noLinks = false): Promise<CommandInfo[]> {
  const out: CommandInfo[] = [];
  for (const dir of dirs) {
    const root = join(dir, 'skills');
    let folders: string[];
    try {
      if (noLinks && (await realpath(root)) !== join(await realpath(join(dir, '..')), '.claude', 'skills')) continue;
      folders = await readdir(root);
    } catch {
      continue;
    }
    for (const folder of folders) {
      let text: string;
      try {
        if (noLinks) {
          const [d, f] = await Promise.all([lstat(join(root, folder)), lstat(join(root, folder, 'SKILL.md'))]);
          if (!d.isDirectory() || !f.isFile()) continue;
        }
        text = await readFile(join(root, folder, 'SKILL.md'), 'utf8');
      } catch {
        continue;
      }
      const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
      const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim().replace(/^["']|["']$/g, '');
      out.push({ name: name || folder, description: frontmatterText(frontmatter, 'description') });
    }
  }
  return out;
}

/** One frontmatter field as plain text: a plain, quoted or block (`>-`) value. */
function frontmatterText(frontmatter: string, key: string): string {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontmatter);
  if (!m) return '';
  const v = (m[1] ?? '').trim();
  if (v.startsWith('>') || v.startsWith('|')) {
    const lines: string[] = [];
    for (const line of frontmatter.slice(m.index + m[0].length).split('\n').slice(1)) {
      if (line && !/^\s/.test(line)) break;
      if (line.trim()) lines.push(line.trim());
    }
    return lines.join(' ');
  }
  if (v.startsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      // not JSON: take it as written
    }
  }
  return v.replace(/^["']|["']$/g, '');
}

export async function installedSkills(dirs: string[]): Promise<Set<string>> {
  return new Set((await skillCommands(dirs)).map((c) => c.name));
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
