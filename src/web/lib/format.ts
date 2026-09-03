export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const parts = path.split('/');
  let out = parts[parts.length - 1] ?? path;
  for (let i = parts.length - 2; i >= 0 && out.length + parts[i]!.length + 1 <= max - 2; i--) {
    out = `${parts[i]}/${out}`;
  }
  return `…/${out}`;
}

export function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

export function money(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
