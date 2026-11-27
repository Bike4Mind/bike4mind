import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: vi.fn() },
  getEffectiveApiKeyByBackend: vi.fn(),
}));

import type { ModelInfo } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  EMPTY_TEMPLATE_DRAFT,
  draftTemplateCopy,
  normalizeTemplateDraft,
  type TemplateDraftUsage,
} from './templateDraft';
import type { OperationsClassifierLlm } from './classifySkill';

const snapshot = {
  name: 'summarize',
  description: 'Summarizes an article',
  body: 'Summarize the article in three bullets.',
  argumentHint: '<article text>',
};
const modelInfo = { id: 'ops-model', backend: 'openai', pricing: { input: 1, output: 2 } } as unknown as ModelInfo;
const llmWith = (complete: OperationsClassifierLlm['complete']): OperationsClassifierLlm => ({
  model: 'ops-model',
  modelInfo,
  complete: vi.fn(complete),
});
const llmReturning = (raw: string) => llmWith(async () => raw);
const record = vi.fn(async () => null);
const usageCtx: TemplateDraftUsage = {
  ledger: { usageEvents: { record } },
  listingId: 'listing-1',
  logger: new Logger({ metadata: {} }),
};
const good = {
  headline: 'Turn any article into three bullets',
  inputs: [{ label: 'Article text', required: true }],
  examplePrompt: 'Summarize this post about solar panels',
  takesFile: false,
};

afterEach(() => {
  vi.useRealTimers();
  record.mockClear();
});

describe('normalizeTemplateDraft', () => {
  it('keeps well-formed copy', () => {
    expect(normalizeTemplateDraft(good)).toEqual(good);
  });

  it.each([null, 'text', ['a'], 3])('returns the empty draft for %j', value => {
    expect(normalizeTemplateDraft(value)).toEqual(EMPTY_TEMPLATE_DRAFT);
  });

  it('caps inputs at three, drops blank or non-string labels and reads required strictly', () => {
    const draft = normalizeTemplateDraft({
      ...good,
      inputs: [
        { label: '  A  ', required: 'yes' },
        { label: '' },
        { label: 7 },
        'loose string',
        { label: 'B', required: true },
        { label: 'C' },
        { label: 'D' },
      ],
    });
    expect(draft.inputs).toEqual([
      { label: 'A', required: false },
      { label: 'B', required: true },
      { label: 'C', required: false },
    ]);
  });

  it('clips over-long fields and collapses whitespace', () => {
    const draft = normalizeTemplateDraft({
      headline: `${'h'.repeat(200)}`,
      inputs: [{ label: 'l'.repeat(100), required: true }],
      examplePrompt: 'line one\n\n  line two',
    });
    expect(draft.headline).toHaveLength(120);
    expect(draft.inputs[0].label).toHaveLength(60);
    expect(draft.examplePrompt).toBe('line one line two');
  });

  it('reads a missing field as empty', () => {
    expect(normalizeTemplateDraft({ headline: 'Only a headline' })).toEqual({
      headline: 'Only a headline',
      inputs: [],
      examplePrompt: '',
      takesFile: false,
    });
  });

  it.each([
    [true, true],
    ['true', false],
    [1, false],
    [undefined, false],
  ])('reads takesFile %j strictly as %j', (value, expected) => {
    expect(normalizeTemplateDraft({ ...good, takesFile: value }).takesFile).toBe(expected);
  });
});

describe('draftTemplateCopy', () => {
  it('parses fenced JSON with prose around it', async () => {
    const raw = `Here it is:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``;
    expect(await draftTemplateCopy(snapshot, llmReturning(raw), usageCtx)).toEqual(good);
  });

  it.each(['no json at all', '{"headline": [}', '[]'])('returns the empty draft for junk %j', async raw => {
    expect(await draftTemplateCopy(snapshot, llmReturning(raw), usageCtx)).toEqual(EMPTY_TEMPLATE_DRAFT);
  });

  it('returns the empty draft when the model throws', async () => {
    const llm = llmWith(async () => Promise.reject(new Error('down')));
    expect(await draftTemplateCopy(snapshot, llm, usageCtx)).toEqual(EMPTY_TEMPLATE_DRAFT);
    expect(record).not.toHaveBeenCalled();
  });

  it('returns the empty draft when the model times out', async () => {
    vi.useFakeTimers();
    const llm = llmWith(() => new Promise<string>(() => {}));
    const pending = draftTemplateCopy(snapshot, llm, usageCtx);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toEqual(EMPTY_TEMPLATE_DRAFT);
  });

  it('wraps the skill in nonce markers and truncates the body', async () => {
    const llm = llmReturning(JSON.stringify(good));
    const body = `${'x'.repeat(8000)}TAIL-BEYOND-LIMIT`;
    await draftTemplateCopy({ ...snapshot, body }, llm, usageCtx);
    const user = vi.mocked(llm.complete).mock.calls[0][1];
    const nonce = user.match(/=====BEGIN SKILL DATA ([0-9a-f]+)=====/)?.[1];
    expect(nonce).toBeTruthy();
    expect(user).toContain(`=====END SKILL DATA ${nonce}=====`);
    expect(user).toContain('argument hint: <article text>');
    expect(user).not.toContain('TAIL-BEYOND-LIMIT');
    expect(vi.mocked(llm.complete).mock.calls[0][0]).toMatch(/UNTRUSTED/);
  });

  it('records the call as platform-paid usage for the listing', async () => {
    const llm = llmWith(async (_system, _user, onUsage) => {
      onUsage?.({ inputTokens: 120, outputTokens: 80 });
      return JSON.stringify(good);
    });
    expect(await draftTemplateCopy(snapshot, llm, usageCtx)).toEqual(good);
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0][0]).toMatchObject({
      userId: 'platform',
      ownerId: 'platform',
      ownerType: 'Platform',
      feature: 'operations',
      source: 'system',
      model: 'ops-model',
      creditsCharged: 0,
      providerInputTokens: 120,
      providerOutputTokens: 80,
      status: 'ok',
      platformPaid: { reason: 'template_draft', listingId: 'listing-1' },
    });
  });

  it('records a call that ran past the timeout once the provider ends it', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const llm = llmWith(
      (_system, _user, onUsage) =>
        new Promise<string>(resolve => {
          finish = () => {
            onUsage?.({ inputTokens: 50, outputTokens: 10 });
            resolve('late');
          };
        })
    );
    const pending = draftTemplateCopy(snapshot, llm, usageCtx);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toEqual(EMPTY_TEMPLATE_DRAFT);
    expect(record).not.toHaveBeenCalled();

    vi.useRealTimers();
    finish();
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0][0]).toMatchObject({ status: 'timeout', providerInputTokens: 50 });
  });

  it('records the billed usage of a call that failed after the provider reported it', async () => {
    const llm = llmWith(async (_system, _user, onUsage) => {
      onUsage?.({ inputTokens: 30 });
      throw new Error('stream broke');
    });
    expect(await draftTemplateCopy(snapshot, llm, usageCtx)).toEqual(EMPTY_TEMPLATE_DRAFT);
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0][0]).toMatchObject({ status: 'error', providerInputTokens: 30 });
  });
});
