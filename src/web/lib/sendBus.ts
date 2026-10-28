// The chat box's send, for a button outside it: an element card's Use /
// Make new answers the agent as if the engineer had typed it.
let sender: ((text: string) => void) | null = null;

export function setSender(fn: ((text: string) => void) | null) {
  sender = fn;
}

export function sendText(text: string): boolean {
  if (!sender) return false;
  sender(text);
  return true;
}
