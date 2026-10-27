import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/chat';
import { renderForSummary } from './compaction';

const message = (id: string, content: string): ChatMessage => ({ id, role: 'user', content, createdAt: '' });

describe('renderForSummary', () => {
  const messages = [
    message('a', `FIRST${'x'.repeat(3000)}`),
    ...Array.from({ length: 20 }, (_, index) => message(`m${index}`, 'y'.repeat(3000))),
    message('z', `LAST${'x'.repeat(3000)}`),
  ];

  it('keeps a conversation under the limit whole', () => {
    const text = renderForSummary(messages);
    expect(text).not.toContain('omitted for length');
    expect(text).toContain('FIRST');
    expect(text).toContain('LAST');
  });

  it('drops the middle to fit a smaller limit, keeping both ends', () => {
    const text = renderForSummary(messages, 10_000);
    expect(text).toContain('omitted for length');
    expect(text.startsWith('--- User ---\nFIRST')).toBe(true);
    expect(text).toContain('LAST');
    expect(text.length).toBeLessThan(10_100);
  });
});
