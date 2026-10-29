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
  triageReleaseNotes,
  trimToBoundary,
  writeReleaseNotes,
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
    const complete = vi.fn().mockResolvedValue('not json');

    await expect(generateReleaseNotes([pr(7, { customerNote: 'n' })], complete)).rejects.toThrow(
      /editorial output invalid after one repair: reply is not valid JSON/
    );
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('drops sourcePrs that are not changes in the release instead of failing it', async () => {
    const warn = vi.fn();
    const complete = vi.fn().mockResolvedValue(editorialReply([7, 4844]));

    const result = await writeReleaseNotes([pr(7)], new Map([[7, 'Search is quicker.']]), complete, {
      logger: { warn },
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.draft.items[0].sourcePrs).toEqual([7]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('4844'));
  });

  it('reduces an item citing only unknown changes to no sources instead of failing the release', async () => {
    const warn = vi.fn();
    const item = (text: string, sourcePrs: number[]) => ({ category: 'improved', text, importance: 1, sourcePrs });
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        headline: 'Faster search',
        summary: 'Quicker.',
        items: [item('A.', [7, 4844]), item('B.', [4845])],
      })
    );

    const result = await writeReleaseNotes([pr(7)], new Map([[7, 'Search is quicker.']]), complete, {
      logger: { warn },
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.draft.items.map(i => i.sourcePrs)).toEqual([[7], []]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('4845'));
  });

  it('accepts an item with no sourcePrs', async () => {
    const complete = vi.fn().mockResolvedValue(editorialReply([]));

    const result = await writeReleaseNotes([pr(7)], new Map([[7, 'n']]), complete);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.draft.items[0].sourcePrs).toEqual([]);
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

  it('re-triages a PR the triage reply skips, on its own', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(triageReply([{ number: 1, customerFacing: true, note: 'One.' }]))
      .mockResolvedValueOnce(triageReply([{ number: 1, customerFacing: true, note: 'One.' }]))
      .mockResolvedValueOnce(triageReply([{ number: 2, customerFacing: true, note: 'Two.' }]));
    const logger = { warn: vi.fn() };

    const { notes, usage } = await triageReleaseNotes([pr(1), pr(2)], complete, { logger });

    expect(complete).toHaveBeenCalledTimes(3);
    const prompts: string[] = complete.mock.calls.map(call => call[0]);
    expect(usage.inputTokens).toBe(prompts.reduce((sum, prompt) => sum + Math.ceil(prompt.length / 4), 0));
    expect(complete.mock.calls[1][0]).toContain('missing entry for pull request 2');
    const retryPrompt: string = complete.mock.calls[2][0];
    expect(retryPrompt).toContain('"number":2');
    expect(retryPrompt).not.toContain('"number":1');
    expect(notes).toEqual(
      new Map([
        [1, 'One.'],
        [2, 'Two.'],
      ])
    );
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('treating them as internal'));
  });

  it('keeps the entries of a partial repair reply that covers more than the first reply', async () => {
    const entry = (number: number) => ({ number, customerFacing: true, note: `Note ${number}.` });
    const complete = vi
      .fn()
      .mockResolvedValueOnce(triageReply([entry(1)]))
      .mockResolvedValueOnce(triageReply([entry(1), entry(2), entry(3)]))
      .mockResolvedValueOnce(triageReply([entry(4)]));
    const logger = { warn: vi.fn() };

    const { notes } = await triageReleaseNotes([pr(1), pr(2), pr(3), pr(4)], complete, { logger });

    expect(complete).toHaveBeenCalledTimes(3);
    expect(complete.mock.calls[2][0]).not.toContain('"number":3');
    expect([...notes.keys()]).toEqual([1, 2, 3, 4]);
  });

  it('drops a PR the model keeps omitting with a warning and ships the rest', async () => {
    const complete = vi.fn(async (prompt: string) =>
      prompt.includes('"number":1')
        ? triageReply([{ number: 1, customerFacing: true, note: 'One.' }])
        : triageReply([{ number: 99, customerFacing: true, note: 'Invented.' }])
    );
    const logger = { warn: vi.fn() };

    const { notes, omitted } = await triageReleaseNotes([pr(1), pr(2)], complete, { logger });

    expect(complete).toHaveBeenCalledTimes(4);
    expect(notes).toEqual(new Map([[1, 'One.']]));
    expect(omitted).toEqual([2]);
    expect(logger.warn).toHaveBeenCalledWith(
      '[releaseNotes] triage omitted pull requests 2; treating them as internal'
    );
  });

  it('treats omitted PRs as internal when the retry call itself fails', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(triageReply([{ number: 1, customerFacing: true, note: 'One.' }]))
      .mockResolvedValueOnce(triageReply([{ number: 1, customerFacing: true, note: 'One.' }]))
      .mockRejectedValueOnce(new Error('timed out'));
    const logger = { warn: vi.fn() };

    const { notes } = await triageReleaseNotes([pr(1), pr(2)], complete, { logger });

    expect(notes).toEqual(new Map([[1, 'One.']]));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('retry for omitted pull requests failed'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('omitted pull requests 2'));
  });

  it('still fails when no triage reply is usable', async () => {
    const complete = vi.fn().mockResolvedValue('not json');

    await expect(triageReleaseNotes([pr(1)], complete)).rejects.toThrow(/triage output invalid after one repair/);
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

describe('triageReleaseNotes / writeReleaseNotes', () => {
  it('caps an author-written customer note before it reaches the editorial prompt', async () => {
    const complete = vi.fn();
    const { notes } = await triageReleaseNotes([pr(1, { customerNote: 'x'.repeat(5000) })], complete);
    expect(complete).not.toHaveBeenCalled();
    expect(notes.get(1)).toHaveLength(600);
  });

  it('writes from already-triaged notes without calling triage again', async () => {
    const complete = vi.fn().mockResolvedValueOnce(editorialReply([1]));
    const { draft } = await writeReleaseNotes([pr(1)], new Map([[1, 'Search is quicker.']]), complete, {
      editorialFeedback: ['fix it'],
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0]).toContain('You write the customer-facing release notes');
    expect(draft.headline).toBe('Faster search');
  });

  it('asks the model for a specific, hype-free headline', async () => {
    const complete = vi.fn().mockResolvedValueOnce(editorialReply([1]));
    await writeReleaseNotes([pr(1)], new Map([[1, 'Search is quicker.']]), complete);
    const prompt: string = complete.mock.calls[0][0];
    expect(prompt).toContain('single most important change in concrete terms');
    expect(prompt).toContain('no exclamation marks');
    expect(prompt).toContain('at most 120 characters');
  });
});

// Author notes from release v2026.10.20.1, each of which overstated what its change does.
const overstatedRelease: ReleaseNotesJobPr[] = [
  pr(4938, {
    title: 'feat(storage): org-admin storage usage endpoint and Storage tab',
    customerNote:
      "Organization admins can now see how much of the organization's storage is used, and by whom, under Usage > Storage.",
  }),
  pr(4994, {
    title: 'fix(music): ask the model to rephrase once when the provider blocks a song prompt',
    customerNote:
      'When a song request is refused because it names a real artist, the assistant now rewrites the request and tries again automatically instead of stopping at a blocked song.',
  }),
  pr(5040, {
    title: 'fix(llm-adapters): run adaptive Claude at low effort for simple queries',
    customerNote: 'Claude answers everyday questions and quick tool lookups faster.',
  }),
];

describe('copy accuracy', () => {
  it('pairs each title with its author note and includes the accuracy and exclusion rules', async () => {
    const complete = vi.fn().mockResolvedValueOnce(editorialReply([4938]));

    await generateReleaseNotes(overstatedRelease, complete);

    const prompt: string = complete.mock.calls[0][0];
    for (const { number, title, customerNote } of overstatedRelease) {
      expect(prompt).toContain(JSON.stringify({ number, title, note: customerNote }));
    }
    expect(prompt).toContain('follow the narrower one');
    expect(prompt).toContain('Never say which roles can see or use something');
    expect(prompt).toContain('never "You can now ..."');
    expect(prompt).toContain('only when the title states that gain');
    expect(prompt).toContain('Never attach a speed or quality claim to an AI model or provider');
    expect(prompt).toContain('is a security vulnerability fix');
    expect(prompt).toContain('Changes only to the operator admin panel');
    expect(prompt).toContain('Settings that customers manage for their own organization are customer-facing');
    expect(prompt).not.toContain('who it helps');
  });

  it('includes the accuracy and exclusion rules in triage, without the title-vs-note rule', async () => {
    const complete = vi.fn().mockResolvedValueOnce(triageReply([{ number: 5075, customerFacing: false, note: '' }]));

    await generateReleaseNotes([pr(5075)], complete);

    const prompt: string = complete.mock.calls[0][0];
    expect(prompt).toContain('Security vulnerability fixes,');
    expect(prompt).toContain('what changes for the customer');
    expect(prompt).toContain('Changes only to the operator admin panel');
    expect(prompt).toContain('Settings that customers manage for their own organization are customer-facing');
    expect(prompt).toContain('Never say which roles can see or use something');
    expect(prompt).not.toContain('follow the narrower one');
  });

  const overLongReply = JSON.stringify({
    headline: 'Storage usage by uploader',
    summary: 'Organizations can see storage usage.',
    items: [{ category: 'new', text: 'x'.repeat(161), importance: 1, sourcePrs: [4938] }],
  });

  it('asks for a repair when an item runs over the cap', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(overLongReply)
      .mockResolvedValueOnce(editorialReply([4938]));

    const { draft } = await writeReleaseNotes(overstatedRelease, new Map([[4938, 'n']]), complete);

    expect(complete.mock.calls[0][0]).toContain('at most 160 characters');
    expect(complete.mock.calls[1][0]).toContain('items.0.text');
    expect(draft.headline).toBe('Faster search');
    expect(draft.items[0].text).toBe('Search is quicker.');
  });

  it('keeps an over-long item whole when the repair still runs over, so the release gets a note', async () => {
    const warn = vi.fn();
    const repairedDraft = {
      headline: 'Repaired headline',
      summary: 'Repaired summary.',
      items: [{ category: 'improved', text: 'y'.repeat(162), importance: 2, sourcePrs: [4938] }],
    };
    const complete = vi.fn().mockResolvedValueOnce(overLongReply).mockResolvedValueOnce(JSON.stringify(repairedDraft));

    const { draft } = await writeReleaseNotes(overstatedRelease, new Map([[4938, 'n']]), complete, {
      logger: { warn },
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(draft).toEqual(repairedDraft);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('over 160 chars'));
  });

  it('drops a stray sourcePr from the kept first draft, warning once', async () => {
    const warn = vi.fn();
    const strayReply = JSON.stringify({
      headline: 'Storage usage by uploader',
      summary: 'Organizations can see storage usage.',
      items: [{ category: 'new', text: 'x'.repeat(161), importance: 1, sourcePrs: [4938, 9999] }],
    });
    const complete = vi.fn().mockResolvedValueOnce(strayReply).mockResolvedValueOnce('not json');

    const { draft } = await writeReleaseNotes(overstatedRelease, new Map([[4938, 'n']]), complete, {
      logger: { warn },
    });

    expect(draft.items[0].sourcePrs).toEqual([4938]);
    expect(warn.mock.calls.filter(([message]) => String(message).includes('9999'))).toHaveLength(1);
  });

  const fieldReply = (fields: { headline?: string; summary?: string }) =>
    JSON.stringify({
      headline: 'Storage usage by uploader',
      summary: 'Organizations can see storage usage.',
      items: [{ category: 'new', text: 'Search is quicker.', importance: 1, sourcePrs: [4938] }],
      ...fields,
    });

  it.each([
    ['summary', { summary: `${'Sentence one is short. '}${'w'.repeat(600)}` }, 'summary: must be at most 600'],
    ['headline', { headline: `${'Fast. '}${'w'.repeat(120)}` }, 'headline: must be at most 120'],
  ])('asks for a repair when the %s runs over the cap', async (_, fields, expectedError) => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(fieldReply(fields))
      .mockResolvedValueOnce(editorialReply([4938]));

    const { draft } = await writeReleaseNotes(overstatedRelease, new Map([[4938, 'n']]), complete);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0]).toContain(expectedError);
    expect(draft.headline).toBe('Faster search');
  });

  it('trims a summary that is still over the cap after the repair instead of failing the release', async () => {
    const warn = vi.fn();
    const long = fieldReply({ summary: `${'Sentence one is short. '}${'w'.repeat(600)}` });
    const complete = vi.fn().mockResolvedValueOnce(long).mockResolvedValueOnce(long);

    const { draft } = await writeReleaseNotes(overstatedRelease, new Map([[4938, 'n']]), complete, {
      logger: { warn },
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(draft.summary.length).toBeLessThanOrEqual(600);
    expect(draft.summary.startsWith('Sentence one is short.')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trimmed summary'));
  });

  it('trims a headline that is still over the cap after the repair instead of failing the release', async () => {
    const warn = vi.fn();
    const long = fieldReply({ headline: `${'word '.repeat(30)}end` });
    const complete = vi.fn().mockResolvedValueOnce(long).mockResolvedValueOnce(long);

    const { draft } = await writeReleaseNotes(overstatedRelease, new Map([[4938, 'n']]), complete, {
      logger: { warn },
    });

    expect(draft.headline.length).toBeLessThanOrEqual(120);
    expect(draft.headline.endsWith('word')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trimmed headline'));
  });

  it('trims an over-long summary when the repair call fails, so the release still gets a note', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(fieldReply({ summary: 'w'.repeat(700) }))
      .mockRejectedValueOnce(new Error('timed out'));

    const { draft } = await writeReleaseNotes(overstatedRelease, new Map([[4938, 'n']]), complete, {
      logger: { warn: vi.fn() },
    });

    expect(draft.summary).toBe('w'.repeat(600));
  });

  it.each([
    [
      'fails schema validation',
      (c: ReturnType<typeof vi.fn>) => c.mockResolvedValueOnce('{"items":[]}'),
      'repair invalid',
    ],
    [
      'is malformed',
      (c: ReturnType<typeof vi.fn>) => c.mockResolvedValueOnce('sorry, here you go: {'),
      'repair invalid',
    ],
    [
      'times out',
      (c: ReturnType<typeof vi.fn>) => c.mockRejectedValueOnce(new Error('timed out')),
      'repair call failed (timed out)',
    ],
  ])('keeps the over-long first draft when the repair %s', async (_, secondReply, warning) => {
    const warn = vi.fn();
    const complete = secondReply(vi.fn().mockResolvedValueOnce(overLongReply));

    const { draft } = await writeReleaseNotes(overstatedRelease, new Map([[4938, 'n']]), complete, {
      logger: { warn },
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(draft).toEqual(JSON.parse(overLongReply));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(warning));
    // The over-length warning fires once, on the draft that is kept.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the first reply fails and there is no draft to keep', async () => {
    const complete = vi.fn().mockRejectedValueOnce(new Error('boom'));

    await expect(writeReleaseNotes(overstatedRelease, new Map([[4938, 'n']]), complete)).rejects.toThrow(/boom/);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('rethrows when a schema-invalid first reply is followed by a failed repair', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          headline: 'Storage usage by uploader',
          items: [{ category: 'new', text: 'x'.repeat(161), importance: 1, sourcePrs: [4938] }],
        })
      )
      .mockRejectedValueOnce(new Error('timed out'));

    await expect(writeReleaseNotes(overstatedRelease, new Map([[4938, 'n']]), complete)).rejects.toThrow(/timed out/);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('does not use an invalid triage response as a fallback when its repair fails', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(triageReply([{ number: 2, customerFacing: true, note: 'Wrong PR.' }]))
      .mockRejectedValueOnce(new Error('timed out'));

    await expect(triageReleaseNotes([pr(1)], complete)).rejects.toThrow('timed out');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1][0]).toContain('missing entry for pull request 1');
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

  it('refuses a call once the deadline has passed', async () => {
    h.getAvailableModels.mockResolvedValue([{ id: DEFAULT_RELEASE_NOTES_MODEL }]);
    const { complete } = await createReleaseNotesCompleter(
      { modelId: DEFAULT_RELEASE_NOTES_MODEL },
      logger as never,
      Date.now() - 1
    );
    await expect(complete('hi')).rejects.toThrow(/time budget exhausted/);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('times a call out at the deadline when it is sooner than the per-call timeout', async () => {
    vi.useFakeTimers();
    try {
      h.getAvailableModels.mockResolvedValue([{ id: DEFAULT_RELEASE_NOTES_MODEL }]);
      llm.complete.mockImplementationOnce(() => new Promise(() => {}));
      const { complete } = await createReleaseNotesCompleter(
        { modelId: DEFAULT_RELEASE_NOTES_MODEL },
        logger as never,
        Date.now() + 1000
      );
      const pending = expect(complete('hi')).rejects.toThrow(/timeout after 1000ms/);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws when neither model is available', async () => {
    h.getAvailableModels.mockResolvedValue([]);

    await expect(createReleaseNotesCompleter({ modelId: 'nope' }, logger as never)).rejects.toThrow(/neither nope/);
  });
});

describe('trimToBoundary', () => {
  it('returns text within the cap untouched', () => {
    expect(trimToBoundary('Short one.', 50)).toBe('Short one.');
  });

  it('cuts at the last sentence end past the halfway mark', () => {
    expect(trimToBoundary('First sentence here. Second sentence runs on and on', 38)).toBe('First sentence here.');
  });

  it('keeps a sentence that ends exactly at the cap', () => {
    expect(trimToBoundary('Ends right here. Next', 16)).toBe('Ends right here.');
  });

  it('falls back to a word boundary when the only sentence end is too early', () => {
    expect(trimToBoundary('Hi. then a very long run of words without stops', 30)).toBe('Hi. then a very long run of');
  });

  it('hard-cuts a single unbroken token', () => {
    expect(trimToBoundary('w'.repeat(50), 20)).toBe('w'.repeat(20));
  });

  it('never leaves half of a surrogate pair', () => {
    const text = `${'a'.repeat(9)}\u{1F600}${'b'.repeat(20)}`;
    expect(trimToBoundary(text, 10)).toBe('a'.repeat(9));
  });
});
