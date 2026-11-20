// A file the agent made or names (an estimate, an audit, a set), as a card:
// its page with the format on it, its name, what it is. The agent writes it
// as a link to the file in the studio's folder: [Estimate.xlsx](https://…/files/<id>).
// A table or a PDF opens in the studio, in the folder, over the work; any
// other file downloads. Download is always beside it.
import { Download } from 'lucide-react';
import type { StudioFile } from '@/lib/fileLink';
import { openInStudio } from '@/lib/fileLinkLive';

export function FileCard({ file, href }: { file: StudioFile; href: string }) {
  // with a modifier key, or the middle button, it is a plain link still
  const open = (e: React.MouseEvent) => {
    if (!file.opens || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openInStudio(file.id, href);
  };
  return (
    <span className="file-row">
      <a
        className="file-row-main"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={open}
        title={file.opens ? `${file.name} — open it in the studio` : `${file.name} — download`}
      >
        <span className={`file-row-pic ${file.tone}`} aria-hidden="true">
          <span>{file.tag}</span>
        </span>
        <span className="file-row-words">
          <span className="file-row-name">{file.name}</span>
          <span className="file-row-facts">{file.what}</span>
        </span>
      </a>
      <span className="file-row-actions">
        {file.opens && (
          <button type="button" className="use" onClick={() => openInStudio(file.id, href)}>
            Open
          </button>
        )}
        <a className="get" href={href} download="" title="Download" aria-label={`Download ${file.name}`}>
          <Download className="size-3.5" />
        </a>
      </span>
    </span>
  );
}
