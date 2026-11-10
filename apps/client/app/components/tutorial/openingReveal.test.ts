import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  REVEAL_SEND_DELAY_MS,
  REVEAL_SENTENCE_PAUSE_MS,
  revealFrames,
  sentenceEnds,
  useOpeningReveal,
  useOpeningSendsItself,
} from './openingReveal';

const LONG_PROMPT =
  'We run a small depot. We start at 6 PM. The first van leaves at 6:30 PM, and the second at 7:15 PM. ' +
  'Every van returns by 9 PM. I need a plan that keeps drivers within their hours. I will drop in the roster sheet.';
const PROMPT = 'First line here. Second one? Third!';
const typingTime = (text: string) => revealFrames(text).reduce((sum, frame) => sum + frame.delay, 0);

describe('sentenceEnds', () => {
  it('ends each sentence after its punctuation and the space that follows', () => {
    expect(sentenceEnds(PROMPT)).toEqual([17, 29, PROMPT.length]);
  });

  it('ends on the text itself when the last sentence has no punctuation', () => {
    expect(sentenceEnds('One. Two')).toEqual([5, 8]);
  });

  it('splits a long opening into its sentences, the clock times included', () => {
    const ends = sentenceEnds(LONG_PROMPT);
    const sentences = ends.map((end, i) => LONG_PROMPT.slice(ends[i - 1] ?? 0, end).trim());
    expect(sentences).toContain('We start at 6 PM.');
    expect(sentences).toContain('The first van leaves at 6:30 PM, and the second at 7:15 PM.');
    expect(sentences.at(-1)).toBe('I will drop in the roster sheet.');
    expect(sentences.join(' ')).toBe(LONG_PROMPT);
  });
});

describe('revealFrames', () => {
  it('ends on the whole text and never goes backwards', () => {
    const frames = revealFrames(PROMPT);
    expect(frames.at(-1)?.length).toBe(PROMPT.length);
    frames.forEach((frame, i) => expect(frame.length).toBeGreaterThan(frames[i - 1]?.length ?? 0));
  });

  it('pauses before each new sentence and nowhere else', () => {
    const paused = revealFrames(PROMPT).filter(frame => frame.delay === REVEAL_SENTENCE_PAUSE_MS);
    expect(paused).toHaveLength(2);
  });

  it('types a long opening in under twenty seconds', () => {
    expect(typingTime(LONG_PROMPT)).toBeLessThan(20_000);
  });
});

describe('useOpeningReveal', () => {
  let reducedMotion = false;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.useFakeTimers();
    reducedMotion = false;
    window.matchMedia = ((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.useRealTimers();
    window.matchMedia = originalMatchMedia;
  });

  const mount = (request: { prompt: string } | null = { prompt: PROMPT }) => {
    let text = '';
    const setText = vi.fn((next: string) => {
      text = next;
    });
    const onTyped = vi.fn();
    const hook = renderHook(props => useOpeningReveal({ request: props, setText, onTyped }), {
      initialProps: request,
    });
    return { hook, setText, onTyped, text: () => text };
  };

  it('types the message a sentence at a time, then sends it once after a beat', () => {
    const { hook, onTyped, text } = mount();
    expect(hook.result.current.typing).toBe(true);
    expect(text().length).toBeGreaterThan(0);
    expect(text().length).toBeLessThan(PROMPT.length);

    act(() => vi.advanceTimersByTime(typingTime(PROMPT)));
    expect(text()).toBe(PROMPT);
    expect(hook.result.current.typing).toBe(false);
    expect(onTyped).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(REVEAL_SEND_DELAY_MS));
    expect(onTyped).toHaveBeenCalledTimes(1);
    act(() => vi.runAllTimers());
    expect(onTyped).toHaveBeenCalledTimes(1);
  });

  it('tells the coach card it sends itself until it has gone, or the user has taken over', () => {
    const sendsItself = () => useOpeningSendsItself.getState().value;
    const first = mount();
    expect(sendsItself()).toBe(true);
    act(() => vi.advanceTimersByTime(typingTime(PROMPT)));
    expect(sendsItself()).toBe(true);
    act(() => vi.advanceTimersByTime(REVEAL_SEND_DELAY_MS));
    expect(sendsItself()).toBe(false);
    first.hook.unmount();

    const second = mount();
    act(() => second.hook.result.current.stop());
    expect(sendsItself()).toBe(false);
    second.hook.unmount();

    reducedMotion = true;
    mount();
    expect(sendsItself()).toBe(false);
  });

  it('holds at the end of a sentence before starting the next', () => {
    const { text } = mount();
    const firstEnd = sentenceEnds(PROMPT)[0];
    const toFirstEnd = revealFrames(PROMPT)
      .filter(frame => frame.length <= firstEnd)
      .reduce((sum, frame) => sum + frame.delay, 0);
    act(() => vi.advanceTimersByTime(toFirstEnd));
    expect(text()).toBe(PROMPT.slice(0, firstEnd));
    act(() => vi.advanceTimersByTime(REVEAL_SENTENCE_PAUSE_MS - 1));
    expect(text()).toBe(PROMPT.slice(0, firstEnd));
  });

  it('shows the whole message on stop, and then never sends it', () => {
    const { hook, onTyped, text } = mount();
    act(() => hook.result.current.stop());
    expect(text()).toBe(PROMPT);
    expect(hook.result.current.typing).toBe(false);
    act(() => vi.runAllTimers());
    expect(onTyped).not.toHaveBeenCalled();
  });

  it('does not send a typed message the user stopped during the wait', () => {
    const { hook, onTyped, text } = mount();
    act(() => vi.advanceTimersByTime(typingTime(PROMPT)));
    act(() => hook.result.current.stop());
    act(() => vi.runAllTimers());
    expect(text()).toBe(PROMPT);
    expect(onTyped).not.toHaveBeenCalled();
  });

  it('lands the whole message at once under reduced motion, and leaves sending to the user', () => {
    reducedMotion = true;
    const { hook, onTyped, setText } = mount();
    expect(setText).toHaveBeenCalledExactlyOnceWith(PROMPT);
    expect(hook.result.current.typing).toBe(false);
    act(() => vi.runAllTimers());
    expect(onTyped).not.toHaveBeenCalled();
  });

  it('clears the half-typed text when the opening is withdrawn, and stops typing', () => {
    const { hook, onTyped, setText, text } = mount();
    act(() => vi.advanceTimersByTime(200));
    hook.rerender(null);
    expect(text()).toBe('');
    expect(hook.result.current.typing).toBe(false);
    const calls = setText.mock.calls.length;
    act(() => vi.runAllTimers());
    expect(setText).toHaveBeenCalledTimes(calls);
    expect(onTyped).not.toHaveBeenCalled();
  });

  it('leaves a fully typed message in place when the opening is withdrawn during the wait', () => {
    const { hook, onTyped, text } = mount();
    act(() => vi.advanceTimersByTime(typingTime(PROMPT)));
    hook.rerender(null);
    expect(text()).toBe(PROMPT);
    act(() => vi.runAllTimers());
    expect(onTyped).not.toHaveBeenCalled();
  });

  it('types the same module again when it is started again', () => {
    const { hook, text } = mount();
    act(() => vi.advanceTimersByTime(typingTime(PROMPT)));
    hook.rerender({ prompt: PROMPT });
    expect(hook.result.current.typing).toBe(true);
    expect(text().length).toBeLessThan(PROMPT.length);
  });

  it('stops every timer when it unmounts', () => {
    const { hook, onTyped, setText } = mount();
    hook.unmount();
    const calls = setText.mock.calls.length;
    act(() => vi.runAllTimers());
    expect(setText).toHaveBeenCalledTimes(calls);
    expect(onTyped).not.toHaveBeenCalled();
  });
});
