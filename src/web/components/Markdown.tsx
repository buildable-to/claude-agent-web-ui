import { useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { linkMarks } from '@/lib/mentions';
import { Mention } from './Mention';

const components: Components = {
  a: ({ href, children, ...props }) => {
    // a mark the agent named: a pill, not a link
    if (href && href.startsWith('mention:')) return <Mention token={href.slice('mention:'.length)} />;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
};

export default function Markdown({ children, marks = [] }: { children: string; marks?: string[] }) {
  const text = useMemo(() => (marks.length ? linkMarks(children, marks) : children), [children, marks]);
  return (
    <div className="prose prose-sm max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        // react-markdown drops hrefs on protocols it does not know; a mark's
        // "mention:" href must survive to reach the pill above
        urlTransform={(url) => (url.startsWith('mention:') ? url : defaultUrlTransform(url))}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
