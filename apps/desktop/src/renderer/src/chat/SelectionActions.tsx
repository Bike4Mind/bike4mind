import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import Button from '@mui/joy/Button';
import Divider from '@mui/joy/Divider';
import Sheet from '@mui/joy/Sheet';
import { messageSelection, type MessageSelection } from './messageSelection';

/** Space between the highlight and the pill, px. */
const GAP = 8;
/** Below this distance from the top of the window the pill goes under the highlight instead. */
const FLIP_ABOVE = 56;
/** Keeps the centred pill clear of the window's sides, px. */
const EDGE = 130;

function placement(rect: MessageSelection['rect']): { top: number; left: number; transform: string } {
  const centre = (rect.left + rect.right) / 2;
  const left = Math.min(Math.max(centre, EDGE), Math.max(EDGE, window.innerWidth - EDGE));
  return rect.top < FLIP_ABOVE
    ? { top: rect.bottom + GAP, left, transform: 'translateX(-50%)' }
    : { top: rect.top - GAP, left, transform: 'translate(-50%, -100%)' };
}

/**
 * The pill that floats over text highlighted in one message: Start a side chat | Reply.
 *
 * It follows the document's selection rather than owning one, so it shows only once a drag ends
 * (or a keyboard selection settles), goes when the highlight does, and also goes on Escape, on a
 * scroll of the thread, and on a press anywhere else. Keyboard users reach it with Tab while it
 * shows; the arrow keys move between its two buttons, as in any toolbar.
 */
export function SelectionActions({
  container,
  onReply,
  onSideChat,
}: {
  /** The thread's scroll host; only highlights inside it count. */
  container: RefObject<HTMLElement | null>;
  onReply: (text: string) => void;
  onSideChat: (text: string) => void;
}) {
  const [current, setCurrent] = useState<MessageSelection | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const read = useCallback(() => {
    const root = container.current;
    if (!root || dragging.current) return;
    if (toolbar.current?.contains(document.activeElement)) return;
    setCurrent(messageSelection(document.getSelection(), root));
  }, [container]);

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const onPointerDown = (event: MouseEvent) => {
      if (toolbar.current?.contains(event.target as Node)) return;
      setCurrent(null);
      dragging.current = root.contains(event.target as Node);
    };
    const onPointerUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      read();
    };
    const onScroll = () => setCurrent(null);
    document.addEventListener('selectionchange', read);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('mouseup', onPointerUp);
    root.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('selectionchange', read);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('mouseup', onPointerUp);
      root.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [container, read]);

  useEffect(() => {
    if (!current) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const inside = toolbar.current?.contains(document.activeElement) ?? false;
      if (event.key === 'Escape') {
        setCurrent(null);
        if (inside) document.getSelection()?.removeAllRanges();
        return;
      }
      if (event.key === 'Tab' && !event.shiftKey && !inside) {
        const first = toolbar.current?.querySelector('button');
        if (!first) return;
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [current]);

  const act = (action: (text: string) => void) => {
    if (!current) return;
    const { text } = current;
    setCurrent(null);
    document.getSelection()?.removeAllRanges();
    action(text);
  };

  const onToolbarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const buttons = Array.from(toolbar.current?.querySelectorAll('button') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  };

  if (!current) return null;

  return createPortal(
    <Sheet
      ref={toolbar}
      role="toolbar"
      aria-label="Actions for the highlighted text"
      variant="outlined"
      data-testid="selection-actions"
      onKeyDown={onToolbarKeyDown}
      // Keeps the press from collapsing the highlight before the click reads it.
      onMouseDown={event => event.preventDefault()}
      sx={{
        position: 'fixed',
        zIndex: 'tooltip',
        ...placement(current.rect),
        display: 'flex',
        alignItems: 'center',
        p: 0.25,
        borderRadius: 'md',
        bgcolor: 'background.popup',
        boxShadow: 'md',
      }}
    >
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        onClick={() => act(onSideChat)}
        data-testid="selection-actions-side-chat-btn"
      >
        Start a side chat
      </Button>
      <Divider orientation="vertical" sx={{ my: 0.75 }} />
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        onClick={() => act(onReply)}
        data-testid="selection-actions-reply-btn"
      >
        Reply
      </Button>
    </Sheet>,
    document.body
  );
}
