import { useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { linkMarks } from '@/lib/mentions';
import { linkViews, type StudioView } from '@/lib/studio';
import { Mention } from './Mention';
import { ViewPill } from './ViewPill';

const components: Components = {
  a: ({ href, children, ...props }) => {
    // a mark the agent named: a pill, not a link
    if (href && href.startsWith('mention:')) return <Mention token={href.slice('mention:'.length)} />;
    // a view the agent named: a pill that frames it on the open sheet
    if (href && href.startsWith('view:')) return <ViewPill token={href.slice('view:'.length)}>{children}</ViewPill>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
};

export default function Markdown({
  children,
  marks = [],
  views = [],
}: {
  children: string;
  marks?: string[];
  views?: StudioView[];
}) {
  const text = useMemo(() => {
    const withMarks = marks.length ? linkMarks(children, marks) : children;
    return views.length ? linkViews(withMarks, views) : withMarks;
  }, [children, marks, views]);
  return (
    <div className="prose prose-sm max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        // react-markdown drops hrefs on protocols it does not know; a mark's
        // "mention:" href must survive to reach the pill above
        urlTransform={(url) => (url.startsWith('mention:') || url.startsWith('view:') ? url : defaultUrlTransform(url))}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
