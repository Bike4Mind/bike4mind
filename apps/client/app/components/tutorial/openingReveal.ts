import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

// Pacing for a room watching the opening message arrive: quick enough that a long brief is done
// in under twenty seconds, with a beat after each sentence so a reader can keep up with what it says.
export const REVEAL_TICK_CHARS = 3;
export const REVEAL_TICK_MS = 36;
export const REVEAL_SENTENCE_PAUSE_MS = 550;
/** The fully typed message stays this long before it sends itself, so its last sentence can be read. */
export const REVEAL_SEND_DELAY_MS = 1200;

/** How much of the message shows, and how long after the previous frame. */
export type RevealFrame = { length: number; delay: number };

/** Where each sentence ends, counting the space after it, so the next one starts on a clean edge. */
export function sentenceEnds(text: string): number[] {
  const ends = Array.from(text.matchAll(/[.?!]["')\]]*\s+/g), match => match.index + match[0].length);
  if (ends.at(-1) !== text.length) ends.push(text.length);
  return ends;
}

/** The message typed a few characters at a time, with a longer beat before each new sentence. */
export function revealFrames(text: string): RevealFrame[] {
  const frames: RevealFrame[] = [];
  let start = 0;
  for (const end of sentenceEnds(text)) {
    let length = start;
    while (length < end) {
      // The first frame shows the moment the opening arrives.
      const delay = frames.length === 0 ? 0 : length === start ? REVEAL_SENTENCE_PAUSE_MS : REVEAL_TICK_MS;
      length = Math.min(end, length + REVEAL_TICK_CHARS);
      frames.push({ length, delay });
    }
    start = end;
  }
  return frames;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

type Phase = 'idle' | 'typing' | 'waiting';

/**
 * Whether the opening in the start box is still on course to send itself, so the coach card beside it can
 * say so. False under reduced motion, once the user skips or edits, and once it has gone.
 */
export const useOpeningSendsItself = create<{ value: boolean }>(() => ({ value: false }));
const setSendsItself = (value: boolean) => useOpeningSendsItself.setState({ value });

/**
 * Types a tutorial's opening message into the start box one sentence at a time, then calls onTyped so the
 * box can send it. Under reduced motion the whole message lands at once and waits for the user's Start.
 *
 * The request is the store's pending opening, compared by identity: starting the same module again types it
 * again. Withdrawing it mid-reveal (Leave, or a session opening) stops the timers and clears the half-typed
 * text, which is nobody's message.
 */
export function useOpeningReveal({
  request,
  setText,
  onTyped,
}: {
  request: { prompt: string } | null;
  setText: (text: string) => void;
  onTyped: () => void;
}): { typing: boolean; stop: () => void } {
  const [typing, setTyping] = useState(false);
  const phase = useRef<Phase>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onTypedRef = useRef(onTyped);
  // Held in a ref so a host's inline setter does not restart the reveal on every render.
  const setTextRef = useRef(setText);
  useEffect(() => {
    onTypedRef.current = onTyped;
    setTextRef.current = setText;
  }, [onTyped, setText]);

  const settle = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    phase.current = 'idle';
    setTyping(false);
    setSendsItself(false);
  }, []);

  useEffect(() => {
    if (!request?.prompt) return;
    const write = (text: string) => setTextRef.current(text);
    const { prompt } = request;
    if (prefersReducedMotion()) {
      write(prompt);
      return;
    }
    const frames = revealFrames(prompt);
    // The first frame lands now: an empty box for even one render would show the example door in its place.
    write(prompt.slice(0, frames[0]?.length ?? 0));
    phase.current = 'typing';
    setTyping(true);
    setSendsItself(true);
    const show = (index: number) => {
      if (index === frames.length) {
        phase.current = 'waiting';
        setTyping(false);
        timer.current = setTimeout(() => {
          phase.current = 'idle';
          timer.current = undefined;
          setSendsItself(false);
          onTypedRef.current();
        }, REVEAL_SEND_DELAY_MS);
        return;
      }
      timer.current = setTimeout(() => {
        write(prompt.slice(0, frames[index].length));
        show(index + 1);
      }, frames[index].delay);
    };
    show(1);
    return () => {
      if (phase.current === 'typing') write('');
      settle();
    };
  }, [request, settle]);

  /** The user takes over: the whole message shows at once, and nothing sends itself. */
  const stop = useCallback(() => {
    if (phase.current === 'idle') return;
    if (phase.current === 'typing' && request) setTextRef.current(request.prompt);
    settle();
  }, [request, settle]);

  return { typing, stop };
}
