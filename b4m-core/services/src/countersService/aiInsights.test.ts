import { describe, expect, it, vi } from 'vitest';

const { openAiCreate } = vi.hoisted(() => ({ openAiCreate: vi.fn() }));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openAiCreate } };
  },
}));

import { generateAIInsights } from './aiInsights';

describe('generateAIInsights', () => {
  it('opts out of OpenAI-side storage', async () => {
    openAiCreate.mockResolvedValue({ choices: [{ message: { content: 'insight' } }] });

    expect(await generateAIInsights({ logs: [], metrics: {} }, 'key')).toBe('insight');
    expect(openAiCreate).toHaveBeenCalledWith(expect.objectContaining({ store: false }));
  });
});
