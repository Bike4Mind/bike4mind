/**
 * Scroll-to-message bridge between the QuestMaster plan board and the
 * virtualized chat history.
 *
 * The chat list is a react-virtuoso list owned by ChatHistory; messages
 * scrolled out of view have no DOM node, so DOM queries cannot reach them.
 * ChatHistory registers a handler that scrolls via Virtuoso's index API;
 * other components (e.g. the plan board in the Knowledge Viewer, which
 * renders in a separate tree) request scrolls through this module.
 */
type ScrollToMessageHandler = (messageId: string) => boolean;

let activeHandler: ScrollToMessageHandler | null = null;

/**
 * Register the handler that performs the scroll. Returns an unregister
 * function; a later registration replaces an earlier one (last mount wins).
 */
export function registerScrollToMessageHandler(handler: ScrollToMessageHandler): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) {
      activeHandler = null;
    }
  };
}

/**
 * Request a scroll to the given chat message.
 * Returns true if a handler found the message and scrolled to it.
 */
export function requestScrollToMessage(messageId: string): boolean {
  return activeHandler ? activeHandler(messageId) : false;
}

/**
 * Briefly highlight the message row once it has scrolled into view.
 * Best-effort: virtuoso mounts the row asynchronously after scrollToIndex,
 * so poll a few frames for the node and animate via the Web Animations API
 * (no global CSS class required).
 */
export function flashMessageHighlight(messageId: string, attempts = 10): void {
  const element = document.querySelector(`[data-message-id="${messageId}"]`);
  if (element instanceof HTMLElement) {
    element.animate(
      [
        { backgroundColor: 'rgba(255, 193, 7, 0.30)' },
        { backgroundColor: 'rgba(255, 193, 7, 0.30)', offset: 0.4 },
        { backgroundColor: 'transparent' },
      ],
      { duration: 1600, easing: 'ease-out' }
    );
    return;
  }
  if (attempts > 0) {
    setTimeout(() => flashMessageHighlight(messageId, attempts - 1), 100);
  }
}
