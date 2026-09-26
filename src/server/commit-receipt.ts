/** The project CLI appends its JSON result after the human digest. Only an
 * explicit successful live CAS receipt can turn a failed tool into a refresh;
 * an error mentioning a project/revision is not evidence of a mutation. */
export function committedProject(text: string): string | null {
  const candidates = [text.trim()];
  for (const match of text.matchAll(/(?:^|\n)\{/g)) candidates.push(text.slice(match.index + (match[0].startsWith('\n') ? 1 : 0)).trim());
  for (const candidate of candidates) {
    let result: unknown;
    try { result = JSON.parse(candidate); } catch { continue; }
    if (!result || typeof result !== 'object') continue;
    const receipt = (result as Record<string, unknown>).commit_receipt;
    if (!receipt || typeof receipt !== 'object') continue;
    const r = receipt as Record<string, unknown>;
    if (r.status === 'committed' && r.applied_to === 'live'
      && typeof r.sess_id === 'string' && r.sess_id.length > 0
      && Number.isSafeInteger(r.rev) && Number(r.rev) >= 1
      && Array.isArray(r.applied) && r.applied.length > 0 && r.applied.every((op) => typeof op === 'string')) return r.sess_id;
  }
  return null;
}
