import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getEffectiveLLMApiKeys: vi.fn(),
  getAvailableModels: vi.fn(),
  getLlmByModel: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {}, apiKeyRepository: {} }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: h.getEffectiveLLMApiKeys } }));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: h.getAvailableModels,
  getLlmByModel: h.getLlmByModel,
}));

import { ChatModels, type ReleaseNotesJobPr } from '@bike4mind/common';
import {
  createReleaseNotesCompleter,
  DEFAULT_RELEASE_NOTES_MODEL,
  extractJson,
  generateReleaseNotes,
} from './generate';

const pr = (number: number, extra: Partial<ReleaseNotesJobPr> = {}): ReleaseNotesJobPr => ({
  number,
  title: `feat: change ${number}`,
  labels: [],
  excerpt: `body ${number}`,
  ...extra,
});

const triageReply = (entries: { number: number; customerFacing: boolean; note: string }[]) =>
  JSON.stringify({ entries });
const editorialReply = (sourcePrs: number[]) =>
  '```json\n' +
  JSON.stringify({
    headline: 'Faster search',
    summary: 'Search is quicker.',
    items: [{ category: 'improved', text: 'Search is quicker.', importance: 1, sourcePrs }],
  }) +
  '\n```';

describe('generateReleaseNotes', () => {
  it('triages un-noted PRs, then writes the editorial from customer-facing notes only', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        triageReply([
          { number: 1, customerFacing: true, note: 'Search is quicker.' },
          { number: 2, customerFacing: false, note: '' },
        ])
      )
      .mockResolvedValueOnce(editorialReply([1]));

    const result = await generateReleaseNotes([pr(1), pr(2)], complete);

    expect(complete).toHaveBeenCalledTimes(2);
    const editorialPrompt: string = complete.mock.calls[1][0];
    expect(editorialPrompt).toContain('"number":1');
    expect(editorialPrompt).not.toContain('"number":2');
    expect(result.draft.items).toEqual([
      { category: 'improved', text: 'Search is quicker.', importance: 1, sourcePrs: [1] },
    ]);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it('repairs once with the validation errors fed back', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ headline: 'x', summary: 'y', items: [{ category: 'bogus' }] }))
      .mockResolvedValueOnce(editorialReply([7]));

    const result = await generateReleaseNotes([pr(7, { customerNote: 'Search is quicker.' })], complete);

    expect(complete).toHaveBeenCalledTimes(2);
    const repairPrompt: string = complete.mock.calls[1][0];
    expect(repairPrompt).toContain('rejected for these reasons');
    expect(repairPrompt).toContain('items.0.category');
    expect(result.draft.headline).toBe('Faster search');
  });

  it('throws when the repair attempt is still invalid', async () => {
    const complete = vi.fn().mockResolvedValue(editorialReply([99]));

    await expect(generateReleaseNotes([pr(7, { customerNote: 'n' })], complete)).rejects.toThrow(
      /editorial output invalid after one repair: sourcePrs references unknown change 99/
    );
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('treats a non-JSON reply as invalid and repairs it', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce('Sorry, I cannot help with that.')
      .mockResolvedValueOnce(triageReply([{ number: 3, customerFacing: false, note: '' }]));

    const result = await generateReleaseNotes([pr(3)], complete);

    expect(complete.mock.calls[1][0]).toContain('reply is not valid JSON');
    expect(result.draft.items).toEqual([]);
  });

  it('rejects a triage reply that skips a PR', async () => {
    const complete = vi.fn().mockResolvedValue(triageReply([{ number: 1, customerFacing: false, note: '' }]));

    await expect(generateReleaseNotes([pr(1), pr(2)], complete)).rejects.toThrow(/missing entry for pull request 2/);
  });

  it('makes no LLM call for an empty PR list', async () => {
    const complete = vi.fn();

    const result = await generateReleaseNotes([], complete);

    expect(complete).not.toHaveBeenCalled();
    expect(result).toEqual({
      draft: { headline: '', summary: '', items: [] },
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it('skips triage when every PR has a customer note, and passes editorial feedback through', async () => {
    const complete = vi.fn().mockResolvedValueOnce(editorialReply([1, 2]));

    await generateReleaseNotes([pr(1, { customerNote: 'One.' }), pr(2, { customerNote: 'Two.' })], complete, [
      'headline mentions a denied term',
    ]);

    expect(complete).toHaveBeenCalledTimes(1);
    const prompt: string = complete.mock.calls[0][0];
    expect(prompt).toContain('You write the customer-facing release notes');
    expect(prompt).toContain('- headline mentions a denied term');
  });
});

describe('extractJson', () => {
  it('throws when there is no object', () => {
    expect(() => extractJson('no json here')).toThrow(/no JSON object/);
  });
});

describe('createReleaseNotesCompleter', () => {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never as { warn: ReturnType<typeof vi.fn> };
  const llm = {
    complete: vi.fn(async (_m: string, _msgs: unknown, _o: unknown, cb: (t: string[]) => Promise<void>) => {
      await cb(['{"ok":', 'true}']);
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    h.getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'k' });
    h.getLlmByModel.mockReturnValue(llm);
  });

  it('falls back to the default model when the configured one is unavailable', async () => {
    h.getAvailableModels.mockResolvedValue([{ id: DEFAULT_RELEASE_NOTES_MODEL }]);

    const { complete, modelId } = await createReleaseNotesCompleter(
      { modelId: ChatModels.CLAUDE_4_5_HAIKU_BEDROCK },
      logger as never
    );

    expect(modelId).toBe(DEFAULT_RELEASE_NOTES_MODEL);
    expect(logger.warn).toHaveBeenCalled();
    await expect(complete('hi')).resolves.toBe('{"ok":true}');
  });

  it('throws when neither model is available', async () => {
    h.getAvailableModels.mockResolvedValue([]);

    await expect(createReleaseNotesCompleter({ modelId: 'nope' }, logger as never)).rejects.toThrow(/neither nope/);
  });
});
