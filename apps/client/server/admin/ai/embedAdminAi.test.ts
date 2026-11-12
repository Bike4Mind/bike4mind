import { describe, expect, it, vi } from 'vitest';
import { AdminAiConfigSchema } from '@bike4mind/common';
import { AdminAiSkip } from './adminAiSkip';
import { embedAdminAi } from './embedAdminAi';

const config = (mode = 'shadow', enabled = true) =>
  AdminAiConfigSchema.parse({
    enabled,
    monthlyCapUsd: 10,
    features: { feedbackTriage: { mode, dailyBudgetUsd: 1, maxCallsPerDay: 100 } },
  });
const fixture = () => {
  const settlement = { settle: vi.fn(async () => {}), fail: vi.fn(async () => {}), refund: vi.fn(async () => {}) };
  const reserve = vi.fn(async () => settlement);
  const embed = vi.fn(async (_text: string) => ({
    vectors: [Array.from({ length: 1536 }, () => 0.1)],
    inputTokens: 10,
  }));
  return { settlement, reserve, embed, loadConfig: async () => config() };
};
describe('budgeted admin embeddings', () => {
  it.each([
    ['off', true],
    ['shadow', false],
  ] as const)('never calls the provider when disabled (%s)', async (mode, enabled) => {
    const deps = fixture();
    expect(
      await embedAdminAi('feedbackTriage', 'hello', { ...deps, loadConfig: async () => config(mode, enabled) })
    ).toEqual({ ok: false, skip: 'disabled' });
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(deps.embed).not.toHaveBeenCalled();
  });
  it('redacts emails and identifiers before embedding and reserves shared limits', async () => {
    const deps = fixture();
    const result = await embedAdminAi('feedbackTriage', 'jane@example.com 64b7f0c2a1b2c3d4e5f60718 203.0.113.9', deps);
    expect(result.ok).toBe(true);
    expect(deps.embed.mock.calls[0]?.[0]).not.toContain('jane@example.com');
    expect(JSON.stringify(deps.embed.mock.calls)).not.toContain('64b7f0c2a1b2c3d4e5f60718');
    expect(deps.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'feedbackTriage',
        limits: expect.objectContaining({ monthlyCapUsd: 10, dailyBudgetUsd: 1, maxCallsPerDay: 100 }),
      })
    );
    expect(deps.settlement.settle).toHaveBeenCalledOnce();
  });
  it('refuses over budget before any provider work', async () => {
    const deps = fixture();
    deps.reserve.mockRejectedValue(new AdminAiSkip('budget'));
    expect(await embedAdminAi('feedbackTriage', 'hello', deps)).toEqual({ ok: false, skip: 'budget' });
    expect(deps.embed).not.toHaveBeenCalled();
  });
  it('retains unknown spend on provider failure and malformed vectors', async () => {
    const deps = fixture();
    deps.embed.mockRejectedValue(new Error('provider failed'));
    expect(await embedAdminAi('feedbackTriage', 'hello', deps)).toEqual({ ok: false, skip: 'provider_down' });
    expect(deps.settlement.fail).toHaveBeenCalledOnce();
    deps.embed.mockResolvedValue({ vectors: [[1]], inputTokens: 1 });
    expect(await embedAdminAi('feedbackTriage', 'hello', deps)).toEqual({ ok: false, skip: 'invalid_output' });
  });
});
