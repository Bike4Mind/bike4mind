import { describe, expect, it } from 'vitest';
import { buildChatRequestMeta } from './chatRequestMeta';

describe('buildChatRequestMeta', () => {
  it('keeps tool names with counts and attachment totals, never arguments or file names', () => {
    const meta = buildChatRequestMeta({
      stopReason: 'max_tokens',
      maxOutputTokens: 64_000,
      limiter: { cappedOutputTokens: 1_200, stoppedForCredits: true },
      reasoningEffort: 'auto:complex',
      thinkingBudgetTokens: 16_000,
      functionCalls: [
        { name: 'web_search', arguments: '{"q":"secret"}' } as { name: string },
        { name: 'web_search' },
        { name: 'image_generation' },
      ],
      attachedFiles: [{ name: 'private.pdf', size: 1_000 } as { size: number }, { size: 500 }],
    });

    expect(meta).toEqual({
      stopReason: 'max_tokens',
      maxOutputTokens: 64_000,
      creditCapOutputTokens: 1_200,
      stoppedForCredits: true,
      reasoningEffort: 'auto:complex',
      thinkingBudgetTokens: 16_000,
      toolCalls: [
        { name: 'web_search', count: 2 },
        { name: 'image_generation', count: 1 },
      ],
      attachmentCount: 2,
      attachmentBytes: 1_500,
    });
    expect(JSON.stringify(meta)).not.toMatch(/secret|private\.pdf/);
  });

  it('leaves everything unset on a plain uncapped turn', () => {
    const meta = buildChatRequestMeta({ limiter: { stoppedForCredits: false } });
    expect(Object.values(meta).every(value => value === undefined)).toBe(true);
  });
});
