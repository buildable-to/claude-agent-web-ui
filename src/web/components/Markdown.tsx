import { useMemo, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { hrefToken, linkMarks } from '@/lib/mentions';
import { linkViews, type StudioView } from '@/lib/studio';
import { studioFile } from '@/lib/fileLink';
import { parentOrigin } from '@/lib/page';
import { Mention } from './Mention';
import { ViewPill } from './ViewPill';
import { ElementCard } from './ElementCard';
import { FileCard } from './FileCard';

const components: Components = {
  // An image in a reply is shown as a link, never loaded by itself: text the
  // agent read (a drawing, a brief) could otherwise make the browser send
  // project data to any address inside an image URL (security review 2026-11-08).
  img: ({ src, alt }) => {
    let host = '';
    try {
      host = typeof src === 'string' ? new URL(src, window.location.href).host : '';
    } catch {
      host = '';
    }
    // plain text: not loaded, not a link, and it says where it points
    return <span className="text-muted-foreground">{`[image${alt ? `: ${alt}` : ''}${host ? ` — ${host}` : ''}]`}</span>;
  },
  a: ({ href, children, ...props }) => {
    // a mark the agent named: a pill, not a link
    if (href && href.startsWith('mention:')) return <Mention token={hrefToken(href, 'mention:')} />;
    // a view the agent named: a pill that frames it on the open sheet
    if (href && href.startsWith('view:')) return <ViewPill token={hrefToken(href, 'view:')}>{children}</ViewPill>;
    // an element the agent found in the library: a card — View, Use, Make new (#942)
    if (href && href.startsWith('element:'))
      return <ElementCard id={hrefToken(href, 'element:')} name={typeof props.title === 'string' ? props.title : undefined}>{children}</ElementCard>;
    // a file in the studio's folder (an estimate the agent made): a card
    // that opens it in the studio, or downloads it
    const file = studioFile(href, plain(children), parentOrigin());
    if (file && href) return <FileCard file={file} href={href} />;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    );
  },
};

/** The words of a link, when it is only words. */
function plain(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plain).join('');
  return '';
}

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
        urlTransform={(url) => (url.startsWith('mention:') || url.startsWith('view:') || url.startsWith('element:') ? url : defaultUrlTransform(url))}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
