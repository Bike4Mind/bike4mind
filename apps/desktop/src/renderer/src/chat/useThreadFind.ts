import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ChatMessage } from '@shared/chat';
import { clearMatches, paintMatches, scrollRangeIntoView } from './findHighlight';
import { isMac } from './platform';
import type { FindTarget } from './ThreadFindContext';
import { collectMatches, describeCount, findPattern, stepMatch, threadSegments } from './threadFind';

/** How long after a move the view keeps following the match while what holds it opens (ms). */
const FOLLOW_REVEAL_MS = 400;

/** Mod+F opens the bar; Mod+G and Mod+Shift+G step while it is open. Exported for the tests. */
export function findShortcut(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>,
  mac = isMac
): 'open' | 'next' | 'previous' | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'f' && !event.shiftKey) return 'open';
  if (key === 'g') return event.shiftKey ? 'previous' : 'next';
  return null;
}

export interface ThreadFind {
  open: boolean;
  query: string;
  setQuery(query: string): void;
  caseSensitive: boolean;
  toggleCase(): void;
  count: string;
  total: number;
  step(direction: 1 | -1): void;
  close(): void;
  /** Bumped on every Mod+F, so a second press re-focuses and re-selects the input. */
  focusRequest: number;
  target: FindTarget | null;
}

/**
 * Find in the open conversation: the bar's state, the match it is on, the Mod+F / Mod+G
 * shortcuts, and painting. Matches come from the messages (see threadFind); the parts of the
 * thread that hold the current one open themselves through ThreadFindContext.
 *
 * The first match shown is the LAST one, nearest the bottom where the reader of a chat is: the
 * first would open the top of a long history on every keystroke.
 */
export function useThreadFind({
  messages,
  host,
  enabled,
  onReveal,
}: {
  messages: readonly ChatMessage[];
  host: RefObject<HTMLElement | null>;
  /** Off, the shortcuts are not bound: a second thread on screen (a peek drawer) has no bar. */
  enabled: boolean;
  /** Called before the view moves to a match, so the thread stops following its bottom. */
  onReveal: () => void;
}): ThreadFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const key = `${caseSensitive ? 'Aa' : 'aa'}:${deferredQuery}`;
  const [selection, setSelection] = useState({ key: '', index: -1, moves: 0 });

  const segments = useMemo(() => (open ? threadSegments(messages) : []), [open, messages]);
  const matches = useMemo(
    () => collectMatches(segments, deferredQuery, caseSensitive),
    [segments, deferredQuery, caseSensitive]
  );
  const total = matches.length;
  const index = selection.key === key ? Math.min(selection.index, total - 1) : total - 1;
  const moves = selection.key === key ? selection.moves : 0;

  // A new number for every distinct position and every explicit move, so a reveal runs again
  // when the reader steps onto a match they had folded away, and not when a reply streams in.
  const seqRef = useRef({ at: '', seq: 0 });
  const at = `${key}#${index}#${moves}`;
  if (seqRef.current.at !== at) seqRef.current = { at, seq: seqRef.current.seq + 1 };
  const seq = seqRef.current.seq;

  const match = open && index >= 0 ? matches[index] : undefined;
  const target = useMemo<FindTarget | null>(() => (match ? { ...match, seq } : null), [match, seq]);

  const step = useCallback(
    (direction: 1 | -1) => {
      setSelection(current => {
        const from = current.key === key ? Math.min(current.index, total - 1) : total - 1;
        return { key, index: stepMatch(from, total, direction), moves: (current.key === key ? current.moves : 0) + 1 };
      });
    },
    [key, total]
  );

  const returnFocus = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    const previous = returnFocus.current;
    returnFocus.current = null;
    if (previous?.isConnected) previous.focus();
  }, []);

  const latest = useRef({ open, step });
  latest.current = { open, step };
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = findShortcut(event);
      if (!action) return;
      if (action === 'open') {
        event.preventDefault();
        if (!latest.current.open && document.activeElement instanceof HTMLElement) {
          returnFocus.current = document.activeElement;
        }
        setOpen(true);
        setFocusRequest(request => request + 1);
        return;
      }
      if (!latest.current.open) return;
      event.preventDefault();
      latest.current.step(action === 'next' ? 1 : -1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);

  // Painted on every DOM change while open, not only on a move: older rounds mount as the reader
  // scrolls, rows open and close, and a streaming reply rewrites its own text.
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;
  const scope = target?.scope;
  const occurrence = target?.occurrence ?? 0;
  useEffect(() => {
    const root = host.current;
    const pattern = open ? findPattern(deferredQuery, caseSensitive) : null;
    if (!root || !pattern) {
      clearMatches();
      return;
    }
    const followUntil = Date.now() + FOLLOW_REVEAL_MS;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const range = paintMatches(root, pattern, scope ? { scope, occurrence } : null);
      if (range && Date.now() < followUntil) {
        revealRef.current();
        scrollRangeIntoView(root, range);
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['open', 'data-expanded'],
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      clearMatches();
    };
  }, [host, open, deferredQuery, caseSensitive, scope, occurrence, seq]);

  return {
    open,
    query,
    setQuery,
    caseSensitive,
    toggleCase: () => setCaseSensitive(value => !value),
    count: deferredQuery ? describeCount(index, total) : '',
    total,
    step,
    close,
    focusRequest,
    target,
  };
}
