// Icons, hues and labels per tool. Adapted from ninehills/claude-agent-ui
// (MIT, see LICENSE-ninehills.txt) and simplified to a single hue per family.

import {
  BookOpen,
  Bot,
  FilePen,
  FilePenLine,
  FileText,
  Globe,
  ListTodo,
  Search,
  SearchCode,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ToolBlock } from '@/lib/transcript';
import { baseName } from '@/lib/format';

export type ToolLook = { icon: ReactNode; hue: string };

const icon = (node: ReactNode) => node;

export function toolLook(name: string): ToolLook {
  switch (name) {
    case 'Read':
      return { icon: icon(<FileText className="size-3.5" />), hue: 'text-emerald-400' };
    case 'Write':
      return { icon: icon(<FilePen className="size-3.5" />), hue: 'text-emerald-400' };
    case 'Edit':
    case 'MultiEdit':
      return { icon: icon(<FilePenLine className="size-3.5" />), hue: 'text-emerald-400' };
    case 'NotebookEdit':
      return { icon: icon(<BookOpen className="size-3.5" />), hue: 'text-emerald-400' };
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return { icon: icon(<Terminal className="size-3.5" />), hue: 'text-amber-400' };
    case 'Grep':
      return { icon: icon(<SearchCode className="size-3.5" />), hue: 'text-violet-400' };
    case 'Glob':
      return { icon: icon(<Search className="size-3.5" />), hue: 'text-violet-400' };
    case 'WebSearch':
    case 'web_search':
    case 'WebFetch':
    case 'web_fetch':
      return { icon: icon(<Globe className="size-3.5" />), hue: 'text-cyan-400' };
    case 'Task':
    case 'Agent':
      return { icon: icon(<Bot className="size-3.5" />), hue: 'text-indigo-400' };
    case 'TodoWrite':
      return { icon: icon(<ListTodo className="size-3.5" />), hue: 'text-indigo-400' };
    case 'Skill':
      return { icon: icon(<Sparkles className="size-3.5" />), hue: 'text-rose-400' };
    default:
      return { icon: icon(<Wrench className="size-3.5" />), hue: 'text-ink-2' };
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Short human label for the row header: "Read", "Run", "Search", ... */
export function toolVerb(tool: ToolBlock): string {
  switch (tool.name) {
    case 'Read':
      return 'Read';
    case 'Write':
      return 'Write';
    case 'Edit':
    case 'MultiEdit':
      return 'Edit';
    case 'NotebookEdit':
      return 'Edit notebook';
    case 'Bash':
      return str(tool.input.description) ?? 'Run';
    case 'BashOutput':
      return 'Shell output';
    case 'KillShell':
      return 'Stop shell';
    case 'Grep':
      return 'Search';
    case 'Glob':
      return 'Find files';
    case 'WebSearch':
    case 'web_search':
      return 'Web search';
    case 'WebFetch':
    case 'web_fetch':
      return 'Fetch';
    case 'Task':
    case 'Agent':
      return str(tool.input.description) ?? 'Sub-agent';
    case 'TodoWrite':
      return 'Todo list';
    case 'Skill':
      return 'Skill';
    case 'AskUserQuestion':
      return 'Question';
    default:
      return tool.name;
  }
}

/** The one detail worth showing next to the verb. */
export function toolDetail(tool: ToolBlock): string | undefined {
  const i = tool.input;
  switch (tool.name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = str(i.file_path) ?? str(i.notebook_path);
      return p ? baseName(p) : undefined;
    }
    case 'Bash':
      return str(i.command);
    case 'Grep':
    case 'Glob':
      return str(i.pattern);
    case 'WebSearch':
    case 'web_search':
      return str(i.query);
    case 'WebFetch':
    case 'web_fetch':
      return str(i.url);
    case 'Task':
    case 'Agent':
      return str(i.subagent_type);
    case 'Skill':
      return str(i.skill) ?? str(i.command);
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? (i.todos as Array<{ status?: string }>) : [];
      const done = todos.filter((t) => t.status === 'completed').length;
      return todos.length ? `${done}/${todos.length} done` : undefined;
    }
    default:
      return undefined;
  }
}

/** Chip colours per tool family, used by the activity row. */
export function toolChip(name: string): string {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'text-emerald-300 hover:bg-emerald-400/20';
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return 'text-amber-300 hover:bg-amber-400/20';
    case 'Grep':
    case 'Glob':
      return 'text-violet-300 hover:bg-violet-400/20';
    case 'WebSearch':
    case 'WebFetch':
    case 'web_search':
    case 'web_fetch':
      return 'text-cyan-300 hover:bg-cyan-400/20';
    case 'Task':
    case 'Agent':
    case 'TodoWrite':
      return 'text-indigo-300 hover:bg-indigo-400/20';
    case 'Skill':
      return 'text-rose-300 hover:bg-rose-400/20';
    default:
      return 'border-line-2 bg-panel text-ink-2 hover:bg-panel-2';
  }
}

export const thinkingChip =
  'text-purple-300 hover:bg-purple-400/20';

/** Very short chip text: "Read auth.ts", "Run tests", "Search “TODO”". */
export function toolChipLabel(tool: ToolBlock): string {
  const detail = toolDetail(tool);
  const verb = toolVerb(tool);
  if (tool.name === 'Bash') return verb.length > 34 ? `${verb.slice(0, 31)}…` : verb;
  if (!detail) return verb;
  const d = detail.length > 22 ? `${detail.slice(0, 19)}…` : detail;
  return `${verb} ${d}`;
}
