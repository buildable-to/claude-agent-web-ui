// Per-tool card bodies. Adapted from ninehills/claude-agent-ui (MIT).
import { CheckCircle2, ChevronRight, Circle } from 'lucide-react';
import type { ToolBlock } from '@/lib/transcript';
import { FilePath, Label, Pre, Tag } from './pieces';
import { ToolRow } from './ToolRow';

type CardProps = { tool: ToolBlock; live: boolean };

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function Result({ tool }: { tool: ToolBlock }) {
  if (tool.result === undefined) return null;
  return (
    <div className="space-y-1">
      <Label>{tool.isError ? 'Error' : 'Result'}</Label>
      <Pre tone={tool.isError ? 'error' : 'plain'}>{tool.result || '(empty)'}</Pre>
    </div>
  );
}

export function BashCard({ tool, live }: CardProps) {
  const command = str(tool.input.command) ?? tool.inputJson ?? '';
  return (
    <ToolRow tool={tool} live={live}>
      <div className="flex flex-wrap gap-1.5">
        {tool.input.run_in_background ? <Tag>background</Tag> : null}
        {tool.input.timeout ? <Tag>timeout {String(tool.input.timeout)}ms</Tag> : null}
      </div>
      <Pre>$ {command}</Pre>
      <Result tool={tool} />
    </ToolRow>
  );
}

export function EditCard({ tool, live }: CardProps) {
  const path = str(tool.input.file_path) ?? '';
  const edits = Array.isArray(tool.input.edits)
    ? (tool.input.edits as Array<{ old_string?: string; new_string?: string }>)
    : [{ old_string: str(tool.input.old_string), new_string: str(tool.input.new_string) }];
  return (
    <ToolRow tool={tool} live={live}>
      <FilePath path={path} />
      {edits.map((e, i) => (
        <div key={i} className="space-y-1">
          {e.old_string ? <Pre tone="remove">{prefixLines('- ', e.old_string)}</Pre> : null}
          {e.new_string ? <Pre tone="add">{prefixLines('+ ', e.new_string)}</Pre> : null}
        </div>
      ))}
      {tool.input.replace_all ? <Tag>replace all</Tag> : null}
      <Result tool={tool} />
    </ToolRow>
  );
}

export function WriteCard({ tool, live }: CardProps) {
  return (
    <ToolRow tool={tool} live={live}>
      <FilePath path={str(tool.input.file_path) ?? ''} />
      <Pre tone="add">{str(tool.input.content) ?? ''}</Pre>
      <Result tool={tool} />
    </ToolRow>
  );
}

export function ReadCard({ tool, live }: CardProps) {
  return (
    <ToolRow tool={tool} live={live}>
      <div className="flex flex-wrap items-center gap-1.5">
        <FilePath path={str(tool.input.file_path) ?? ''} />
        {tool.input.offset !== undefined ? <Tag>from line {String(tool.input.offset)}</Tag> : null}
        {tool.input.limit !== undefined ? <Tag>{String(tool.input.limit)} lines</Tag> : null}
      </div>
      <Result tool={tool} />
    </ToolRow>
  );
}

export function SearchCard({ tool, live }: CardProps) {
  return (
    <ToolRow tool={tool} live={live}>
      <div className="flex flex-wrap items-center gap-1.5">
        <FilePath path={str(tool.input.pattern) ?? ''} />
        {tool.input.path ? <span className="text-[12px] text-ink-2">in {String(tool.input.path)}</span> : null}
        {tool.input.glob ? <Tag>{String(tool.input.glob)}</Tag> : null}
      </div>
      <Result tool={tool} />
    </ToolRow>
  );
}

export function WebCard({ tool, live }: CardProps) {
  const url = str(tool.input.url);
  const query = str(tool.input.query);
  const prompt = str(tool.input.prompt);
  return (
    <ToolRow tool={tool} live={live}>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate font-mono text-[12px] text-accent hover:underline"
        >
          {url}
        </a>
      ) : null}
      {query ? <FilePath path={query} /> : null}
      {prompt ? <p className="text-[13px] text-ink-2">{prompt}</p> : null}
      <Result tool={tool} />
    </ToolRow>
  );
}

export function TaskCard({ tool, live }: CardProps) {
  const prompt = str(tool.input.prompt);
  return (
    <ToolRow tool={tool} live={live} defaultOpen={live && tool.result === undefined}>
      <div className="flex flex-wrap gap-1.5">
        {tool.input.subagent_type ? <Tag>{String(tool.input.subagent_type)}</Tag> : null}
        {tool.input.model ? <Tag>{String(tool.input.model)}</Tag> : null}
      </div>
      {prompt ? <Pre>{prompt}</Pre> : null}
      {tool.children.length > 0 && (
        <div className="space-y-1">
          <Label>Sub-agent tool calls</Label>
          <div className="space-y-1">
            {tool.children.map((child) => (
              <ToolCard key={child.id} tool={child} live={live && child.result === undefined} />
            ))}
          </div>
        </div>
      )}
      <Result tool={tool} />
    </ToolRow>
  );
}

export function TodoCard({ tool, live }: CardProps) {
  const todos = Array.isArray(tool.input.todos)
    ? (tool.input.todos as Array<{ content?: string; status?: string }>)
    : [];
  return (
    <ToolRow tool={tool} live={live}>
      <ul className="space-y-1">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px]">
            <span className="mt-0.5 shrink-0">
              {t.status === 'completed' ? (
                <CheckCircle2 className="size-3.5 text-ok" />
              ) : t.status === 'in_progress' ? (
                <ChevronRight className="size-3.5 text-accent" />
              ) : (
                <Circle className="size-3.5 text-ink-3" />
              )}
            </span>
            <span className={t.status === 'completed' ? 'text-ink-3 line-through' : 'text-ink'}>
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </ToolRow>
  );
}

export function GenericCard({ tool, live }: CardProps) {
  const hasInput = Object.keys(tool.input).length > 0 || Boolean(tool.inputJson);
  return (
    <ToolRow tool={tool} live={live}>
      {hasInput ? (
        <div className="space-y-1">
          <Label>Input</Label>
          <Pre>{Object.keys(tool.input).length ? JSON.stringify(tool.input, null, 2) : tool.inputJson}</Pre>
        </div>
      ) : null}
      <Result tool={tool} />
    </ToolRow>
  );
}

export function ToolCard({ tool, live }: CardProps) {
  switch (tool.name) {
    case 'Bash':
      return <BashCard tool={tool} live={live} />;
    case 'Edit':
    case 'MultiEdit':
      return <EditCard tool={tool} live={live} />;
    case 'Write':
      return <WriteCard tool={tool} live={live} />;
    case 'Read':
      return <ReadCard tool={tool} live={live} />;
    case 'Grep':
    case 'Glob':
      return <SearchCard tool={tool} live={live} />;
    case 'WebSearch':
    case 'WebFetch':
    case 'web_search':
    case 'web_fetch':
      return <WebCard tool={tool} live={live} />;
    case 'Task':
    case 'Agent':
      return <TaskCard tool={tool} live={live} />;
    case 'TodoWrite':
      return <TodoCard tool={tool} live={live} />;
    default:
      return <GenericCard tool={tool} live={live} />;
  }
}

function prefixLines(prefix: string, text: string): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}
