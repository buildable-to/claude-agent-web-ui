/** How many of the newest uuids a page sends with an attach. The engineer's
 *  own words are never echoed into the server's buffer, so the newest uuid
 *  may be one the server never had; a few dozen back always reach one it did. */
export const KNOWN_KEEP = 50;

type Seen = { type: string; uuid?: string; parent_tool_use_id?: string | null };

/** `known` plus the main-conversation messages in `messages`, newest last,
 *  at most KNOWN_KEEP. Helpers' messages are not in history, so they never
 *  count as known. */
export function rememberKnown(known: readonly string[], messages: readonly Seen[]): string[] {
  const out = [...known];
  for (const m of messages) {
    if ((m.type === 'user' || m.type === 'assistant') && !m.parent_tool_use_id && m.uuid) out.push(m.uuid);
  }
  return out.slice(-KNOWN_KEEP);
}
