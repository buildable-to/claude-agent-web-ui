// The chat box's send, for a button outside it: an element card's Use — in
// the chat, or in the studio's element popup — answers the agent as if the
// engineer had typed it, and every card of that element shows it is used.
let sender: ((text: string) => void) | null = null;
const titles = new Map<string, string>();
const answered = new Set<string>();
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

export function isUsed(id: string): boolean {
  return answered.has(id);
}

export function onAnswers(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Use this element: the words the agent reads. */
export function chooseElement(id: string): boolean {
  const title = titles.get(id) ?? `element ${id}`;
  const ok = sendText(`Use ${title} (element ${id}).`);
  if (ok) {
    answered.add(id);
    listeners.forEach((fn) => fn());
  }
  return ok;
}
