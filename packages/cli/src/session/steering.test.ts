import { describe, it, expect, beforeEach } from 'vitest';
import { deliverSteers, formatSteerFeedback } from './steering';
import { useCliStore } from '../store';
import type { Session } from '../storage';

function seedSession(): void {
  const session: Session = {
    id: 'sess-1',
    name: 'test session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    model: 'claude-sonnet-4-6',
    messages: [],
    metadata: { totalTokens: 0, totalCost: 0, toolCallCount: 0 },
  };
  useCliStore.getState().setSession(session);
}

describe('steering', () => {
  beforeEach(() => {
    useCliStore.setState({ session: null, messageQueue: [], inputValue: '' });
  });

  it('formats no steers as null and several as one block in order', () => {
    expect(formatSteerFeedback([])).toBeNull();
    expect(formatSteerFeedback(['a', 'b'])).toMatch(/while you were working[\s\S]*\n\na\n\nb$/);
  });

  it('delivers only steers, leaving follow-ups queued in order', () => {
    seedSession();
    const { enqueueMessage } = useCliStore.getState();
    enqueueMessage('f1', 'followUp');
    enqueueMessage('s1');
    enqueueMessage('f2', 'followUp');
    enqueueMessage('s2');

    const delivered = deliverSteers(new AbortController().signal);

    expect(delivered?.steers).toEqual(['s1', 's2']);
    expect(useCliStore.getState().messageQueue.map(entry => entry.text)).toEqual(['f1', 'f2']);
    expect(useCliStore.getState().session!.messages.map(m => m.content)).toEqual(['s1', 's2']);
  });

  it('delivers nothing to a cancelled turn or without a session', () => {
    useCliStore.getState().enqueueMessage('s1');
    expect(deliverSteers(new AbortController().signal)).toBeNull();

    seedSession();
    const controller = new AbortController();
    controller.abort();
    expect(deliverSteers(controller.signal)).toBeNull();
    expect(useCliStore.getState().messageQueue).toEqual([{ text: 's1', kind: 'steer' }]);
  });

  it('restores the queue to the input ahead of any draft, and is a no-op when empty', () => {
    const store = useCliStore.getState();
    store.setInputValue('draft');
    store.restoreQueueToInput();
    expect(useCliStore.getState().inputValue).toBe('draft');

    store.enqueueMessage('s1');
    store.enqueueMessage('see @a.ts\n--- File: a.ts ---\n...', 'followUp', 'see @a.ts');
    store.restoreQueueToInput();
    // The typed form is restored, so a resend expands `@a.ts` once rather than carrying the old expansion.
    expect(useCliStore.getState()).toMatchObject({ messageQueue: [], inputValue: 's1\nsee @a.ts\ndraft' });
  });
});
