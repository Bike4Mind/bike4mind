import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatStreamEvent } from '@shared/chat';
import { ProgressBatcher, type LoopProgressFrame } from './progress';

const base = { sessionId: 's', messageId: 'm' };
const call = { id: 'c1', name: 'bash_execute', input: { command: 'ls' }, status: 'running' as const };

afterEach(() => vi.useRealTimers());

describe('ProgressBatcher', () => {
  it('joins text, keeps the last usage, and posts one batch per interval', async () => {
    vi.useFakeTimers();
    const sent: LoopProgressFrame[][] = [];
    const batcher = new ProgressBatcher(
      async frames => void sent.push(frames),
      () => undefined
    );
    const events: ChatStreamEvent[] = [
      { type: 'delta', ...base, text: 'Hel' },
      { type: 'delta', ...base, text: 'lo' },
      { type: 'usage', ...base, usage: { creditsUsed: 1 } },
      { type: 'tool-start', ...base, call },
      { type: 'phase', ...base, phase: { kind: 'thinking' } },
      { type: 'tool-end', ...base, call: { ...call, status: 'done', preview: 'a\nb' } },
      { type: 'usage', ...base, usage: { creditsUsed: 2 } },
    ];
    for (const event of events) batcher.push(event);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sent).toEqual([
      [
        { type: 'text', text: 'Hello' },
        { type: 'tool-start', callId: 'c1', name: 'bash_execute', input: '{"command":"ls"}' },
        { type: 'tool-end', callId: 'c1', name: 'bash_execute', status: 'done', preview: 'a\nb' },
        { type: 'usage', usage: { creditsUsed: 2 } },
      ],
    ]);
  });

  it('reports a failed post', async () => {
    const errors: unknown[] = [];
    const batcher = new ProgressBatcher(
      async () => {
        throw new Error('lease lost');
      },
      error => errors.push(error)
    );
    batcher.push({ type: 'delta', ...base, text: 'x' });
    await batcher.flush();
    expect(errors).toHaveLength(1);
    batcher.dispose();
  });
});
