// The chat box's send, for a button outside it: an element card's Use / New
// — in the chat, or in the studio's element popup — answers the agent as if
// the engineer had typed it, and every card of that element shows the answer.
let sender: ((text: string) => void) | null = null;
const titles = new Map<string, string>();
const answered = new Map<string, 'use' | 'new'>();
const listeners = new Set<() => void>();

export function setSender(fn: ((text: string) => void) | null) {
  sender = fn;
}

export function sendText(text: string): boolean {
  if (!sender) return false;
  sender(text);
  return true;
}

export function knowElement(id: string, title: string) {
  if (!titles.has(id)) titles.set(id, title);
}

export function answerOf(id: string): 'use' | 'new' | undefined {
  return answered.get(id);
}

export function onAnswers(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Use this element, or make a new one instead: the words the agent reads. */
export function answerElement(id: string, kind: 'use' | 'new'): boolean {
  const title = titles.get(id) ?? `element ${id}`;
  const ok = sendText(kind === 'use'
    ? `Use ${title} (element ${id}).`
    : `Make a new element instead of ${title} (element ${id}).`);
  if (ok) {
    answered.set(id, kind);
    listeners.forEach((fn) => fn());
  }
  return ok;
}
