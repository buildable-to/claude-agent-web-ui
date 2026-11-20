// The live side of a table's link (fileLink.ts): the click that asks the
// studio to open it.
import { parentOrigin, tellParent } from './page';

/** How long the studio has to say it opened the file before it is downloaded. */
const ANSWER_MS = 1500;

/** Ask the studio to open the table; with no answer (an older studio page,
 *  a file that is gone) download it, so a click never does nothing. */
export function openInStudio(file: string, href: string) {
  const studio = parentOrigin();
  if (!studio) return;
  const download = () => {
    const a = document.createElement('a');
    a.href = href;
    a.download = '';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const timer = window.setTimeout(() => {
    window.removeEventListener('message', heard);
    download();
  }, ANSWER_MS);
  function heard(e: MessageEvent) {
    if (e.origin !== studio || e.source !== window.parent) return;
    const m = e.data as { source?: unknown; type?: unknown; file?: unknown } | null;
    if (!m || m.source !== 'buildable-studio' || m.type !== 'file_opened' || m.file !== file) return;
    window.clearTimeout(timer);
    window.removeEventListener('message', heard);
  }
  window.addEventListener('message', heard);
  tellParent({ type: 'open_file', file });
}
