// A file the agent made or names (an estimate, an audit, a set), as a card:
// a coloured tile with its kind's sign (green a table, red a PDF, grey the
// rest), its name, what it is. The agent writes it as a link to the file in
// the studio's folder: [Estimate.xlsx](https://…/files/<id>).
// The card is the action: a table or a PDF opens in the studio, in the
// folder, over the work; any other file downloads. Download is always beside it.
import { Download, File, FileText, Table2 } from 'lucide-react';
import type { StudioFile } from '@/lib/fileLink';
import { openInStudio } from '@/lib/fileLinkLive';

const SIGN = { table: Table2, pdf: FileText, plain: File };

export function FileCard({ file, href }: { file: StudioFile; href: string }) {
  const Sign = SIGN[file.tone];
  // with a modifier key, or the middle button, it is a plain link still
  const open = (e: React.MouseEvent) => {
    if (!file.opens || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openInStudio(file.id, href);
  };
  return (
    <span className="file-card">
      <a
        className="file-card-main"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={open}
        title={file.opens ? `${file.name} — open it in the studio` : `${file.name} — download`}
      >
        <span className={`file-card-sign ${file.tone}`} aria-hidden="true">
          <Sign className="size-5" strokeWidth={1.8} />
        </span>
        <span className="file-card-words">
          <span className="file-card-name">{file.name}</span>
          <span className="file-card-kind">{file.opens ? file.what : `${file.what} · downloads`}</span>
        </span>
      </a>
      <a className="file-card-get" href={href} download="" title="Download" aria-label={`Download ${file.name}`}>
        <Download className="size-4" strokeWidth={1.8} />
      </a>
    </span>
  );
}
