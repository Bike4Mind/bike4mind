import type { ChatMessage } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { buildThread, LARGEST_REAL_SHAPE, STRESS_SHAPE } from './threadFixture';
import { clampWindow, extendWindow, initialWindow, unitsOf, WINDOW_STEP, type ThreadWindow } from './threadWindow';

/** Stored rounds a window draws, counting each message as unitsOf does. */
function drawnUnits(messages: readonly ChatMessage[], window: ThreadWindow, to = messages.length): number {
  let units = 0;
  for (let index = window.start; index < to; index++) units += unitsOf(messages[index]);
  return units - window.skip;
}

function reply(id: string, rounds: number): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    rounds: Array.from({ length: rounds }, (_, index) => ({ text: `round ${index}`, toolCallIds: [] })),
  };
}

describe('the thread window', () => {
  it('opens the stress fixture on one step of rounds, however long the thread is', () => {
    const messages = buildThread(STRESS_SHAPE);
    const window = initialWindow(messages, 0, messages.length, WINDOW_STEP);

    expect(drawnUnits(messages, window)).toBe(WINDOW_STEP);
    expect(window.start).toBeGreaterThan(messages.length - 10);
  });

  it('ends inside a reply that alone holds more rounds than a step', () => {
    const messages = buildThread(LARGEST_REAL_SHAPE);
    const last = messages.length - 1;

    expect(initialWindow(messages, 0, messages.length, WINDOW_STEP)).toEqual({
      start: last,
      skip: unitsOf(messages[last]) - WINDOW_STEP,
    });
  });

  it('grows by a step each time and stops at the floor', () => {
    const messages = buildThread(STRESS_SHAPE);
    const floor = STRESS_SHAPE.boundaryAt ?? 0;
    let window = initialWindow(messages, floor, messages.length, WINDOW_STEP);
    let steps = 0;
    while (window.start > floor || window.skip > 0) {
      const next = extendWindow(messages, floor, window, WINDOW_STEP);
      expect(drawnUnits(messages, next) - drawnUnits(messages, window)).toBeLessThanOrEqual(WINDOW_STEP);
      expect(next.start).toBeLessThanOrEqual(window.start);
      window = next;
      steps++;
    }

    expect(window).toEqual({ start: floor, skip: 0 });
    expect(steps).toBeGreaterThan(1);
    expect(extendWindow(messages, floor, window, WINDOW_STEP)).toEqual(window);
  });

  it('keeps its top where it was while a reply streams in below it', () => {
    const messages = [reply('a', 30), reply('b', 30)];
    const window = initialWindow(messages, 0, messages.length, WINDOW_STEP);
    const streamed = [...messages, reply('c', 50)];

    expect(window).toEqual({ start: 1, skip: 6 });
    expect(extendWindow(streamed, 0, window, WINDOW_STEP)).toEqual({ start: 0, skip: 12 });
  });

  it('is fitted back inside a range that moved under it', () => {
    expect(clampWindow({ start: 2, skip: 3 }, 5, 10)).toEqual({ start: 5, skip: 0 });
    expect(clampWindow({ start: 12, skip: 3 }, 0, 10)).toEqual({ start: 10, skip: 0 });
    expect(clampWindow({ start: 6, skip: 3 }, 0, 10)).toEqual({ start: 6, skip: 3 });
  });

  it('draws an empty range as complete', () => {
    expect(initialWindow([], 0, 0, WINDOW_STEP)).toEqual({ start: 0, skip: 0 });
  });
});
