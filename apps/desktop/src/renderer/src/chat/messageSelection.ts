/**
 * Which text the user highlighted in the thread, when it is something the selection actions
 * (Reply, Start a side chat) can act on.
 *
 * Both ends of the selection must sit in the SAME message: a range spanning two turns has no
 * single speaker to quote, and quoting it would splice their words together. Anything typed into
 * a field (the composer, a tool's input) is not part of the conversation and is left to the
 * field's own menu.
 */

/** The elements one message is drawn in; see UserTurn and AssistantTurn in MessageThread. */
export const MESSAGE_SELECTOR = '[data-testid="chat-message-assistant"], [data-testid="chat-message-user"]';

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable=""], [contenteditable="true"]';

export interface MessageSelection {
  text: string;
  /** Where the highlight is on screen, for placing the actions above it. */
  rect: { top: number; bottom: number; left: number; right: number };
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function messageOf(node: Node | null, root: Element): Element | null {
  const element = elementOf(node);
  if (!element || !root.contains(element) || element.closest(EDITABLE_SELECTOR)) return null;
  const message = element.closest(MESSAGE_SELECTOR);
  return message && root.contains(message) ? message : null;
}

export function messageSelection(selection: Selection | null, root: Element): MessageSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const message = messageOf(selection.anchorNode, root);
  if (!message || messageOf(selection.focusNode, root) !== message) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const bounds = selection.getRangeAt(0).getBoundingClientRect();
  return { text, rect: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right } };
}
