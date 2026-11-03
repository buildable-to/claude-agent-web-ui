/** When a message was said, short: "14:05" today, "3 Nov 14:05" another day,
 *  "3 Nov 2025 14:05" another year. In the reader's own time zone. */
export function saidAtLabel(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const n = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === n.toDateString()) return time;
  const day = d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === n.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${day} ${time}`;
}
