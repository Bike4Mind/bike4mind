import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatStreamEvent } from '@shared/chat';
import type { LoopProgressFrame } from '@bike4mind/common';
import { PROGRESS_LIMITS, ProgressBatcher, toPosts } from './progress';

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

describe('toPosts', () => {
  it('splits long text and caps frames and bytes per post, within the route limits', () => {
    const long: LoopProgressFrame = { type: 'text', text: 'x'.repeat(9_000) };
    expect(
      toPosts([long])
        .flat()
        .map(frame => (frame.type === 'text' ? frame.text.length : 0))
    ).toEqual([4_000, 4_000, 1_000]);

    const many = Array.from({ length: 450 }, (_unused, index): LoopProgressFrame => ({
      type: 'text',
      text: `${index}`,
    }));
    expect(toPosts(many).map(post => post.length)).toEqual([200, 200, 50]);

    const big = Array.from({ length: 120 }, (): LoopProgressFrame => ({ type: 'text', text: 'y'.repeat(3_900) }));
    for (const post of toPosts(big)) {
      expect(Buffer.byteLength(JSON.stringify({ frames: post }))).toBeLessThan(256 * 1024);
      expect(post.length).toBeLessThanOrEqual(PROGRESS_LIMITS.frames);
    }
  });
});
