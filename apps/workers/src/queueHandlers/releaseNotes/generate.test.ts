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
    expect(prompt).toContain('or a security vulnerability fix');
    expect(prompt).toContain('Changes only to the operator admin panel');
    expect(prompt).not.toContain('who it helps');
  });

  it('includes the accuracy and exclusion rules in triage, without the title-vs-note rule', async () => {
    const complete = vi.fn().mockResolvedValueOnce(triageReply([{ number: 5075, customerFacing: false, note: '' }]));

    await generateReleaseNotes([pr(5075)], complete);

    const prompt: string = complete.mock.calls[0][0];
    expect(prompt).toContain('Security vulnerability fixes,');
    expect(prompt).toContain('what changes for the customer');
    expect(prompt).toContain('Changes only to the operator admin panel');
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
          headline: 'x'.repeat(121),
          summary: 'Organizations can see storage usage.',
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
