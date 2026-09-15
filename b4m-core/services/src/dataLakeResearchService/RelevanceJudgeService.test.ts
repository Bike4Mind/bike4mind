import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ApiKeyTable } from '@bike4mind/llm-adapters';
import { ChatModels, type ModelInfo } from '@bike4mind/common';

// Fake backend whose `complete` streams whatever the test set, and reports whatever usage the test
// set. Mirrors LakeMemoryExtractionService.test.ts.
let nextResponse = '';
let nextUsage: { inputTokens?: number; outputTokens?: number } | undefined;
/** Usage frames delivered one per callback, for the running-total case. */
let usageFrames: Array<{ inputTokens?: number; outputTokens?: number }> | undefined;
let lastPrompt = '';
let llmAvailable = true;

vi.mock('@bike4mind/llm-adapters', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters');
  return {
    ...actual,
    getLlmByModel: () =>
      llmAvailable
        ? {
            complete: async (
              _model: string,
              messages: Array<{ content: string }>,
              _opts: unknown,
              callback: (texts: string[], info?: unknown) => Promise<void>
            ) => {
              lastPrompt = messages[0].content;
              if (usageFrames) {
                for (const frame of usageFrames) await callback([''], frame);
                await callback([nextResponse], undefined);
                return;
              }
              await callback([nextResponse], nextUsage);
            },
          }
        : null,
  };
});

const { RelevanceJudgeService, buildRelevanceJudgePrompt, RELEVANCE_JUDGE_DEFAULT_MODEL } =
  await import('./RelevanceJudgeService');

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

const apiKeyTable = { openai: 'k-openai' } as ApiKeyTable;

/** Rates in USD per token, chosen so 1000 in + 1000 out is exactly $0.001 -> 1000 micro-USD. */
const judgeModel = {
  id: ChatModels.GPT4_1_MINI,
  type: 'text',
  name: 'Judge',
  pricing: { 128_000: { input: 0.0000005, output: 0.0000005 } },
} as unknown as ModelInfo;

const service = new RelevanceJudgeService(silentLogger);

const judge = (overrides: Partial<Parameters<typeof service.judge>[0]> = {}) =>
  service.judge({
    apiKeyTable,
    models: [judgeModel],
    model: ChatModels.GPT4_1_MINI,
    question: 'How fast is coastal erosion in Cornwall?',
    title: 'Cornwall coastal erosion rates',
    url: 'https://example.com/erosion',
    snippet: 'Measured retreat rates from 1990 to 2024.',
    ...overrides,
  });

beforeEach(() => {
  nextResponse = '';
  nextUsage = undefined;
  usageFrames = undefined;
  lastPrompt = '';
  llmAvailable = true;
  vi.clearAllMocks();
});

describe('buildRelevanceJudgePrompt', () => {
  it('carries the question and the candidate, and frames the candidate as untrusted', () => {
    const prompt = buildRelevanceJudgePrompt('the question', 'the title', 'https://example.com', 'the snippet');
    expect(prompt).toContain('the question');
    expect(prompt).toContain('the title');
    expect(prompt).toContain('https://example.com');
    expect(prompt).toContain('the snippet');
    expect(prompt).toContain('untrusted text');
  });
});

describe('RelevanceJudgeService.judge', () => {
  it('parses a well-formed judgment and prices what it cost', async () => {
    nextResponse = JSON.stringify({ relevance: 0.82, rationale: '  Directly on topic.  ' });
    nextUsage = { inputTokens: 1_000, outputTokens: 1_000 };

    expect(await judge()).toEqual({ relevance: 0.82, rationale: 'Directly on topic.', costMicroUsd: 1_000 });
  });

  it('reads the judgment out of a response wrapped in prose or a code fence', async () => {
    nextResponse = 'Sure:\n```json\n{"relevance": 0.4}\n```\n';
    expect(await judge()).toMatchObject({ relevance: 0.4 });
  });

  it('clamps an out-of-range score, so a caller comparing against minRelevance never sees one', async () => {
    nextResponse = JSON.stringify({ relevance: 7 });
    expect((await judge())?.relevance).toBe(1);

    nextResponse = JSON.stringify({ relevance: -3 });
    expect((await judge())?.relevance).toBe(0);
  });

  it('drops a blank rationale rather than showing an empty line on the card', async () => {
    nextResponse = JSON.stringify({ relevance: 0.7, rationale: '   ' });
    expect((await judge())?.rationale).toBeUndefined();
  });

  it('reports zero cost when the provider reported no usage', async () => {
    nextResponse = JSON.stringify({ relevance: 0.9 });
    expect((await judge())?.costMicroUsd).toBe(0);
  });

  // Providers report a RUNNING TOTAL per stream. Accumulating the frames would over-count the spend
  // charged against the run's ceiling, which is the lever this feeds.
  it('takes the last reported usage rather than summing the frames', async () => {
    nextResponse = JSON.stringify({ relevance: 0.9 });
    usageFrames = [
      { inputTokens: 400, outputTokens: 100 },
      { inputTokens: 1_000, outputTokens: 1_000 },
    ];
    expect((await judge())?.costMicroUsd).toBe(1_000);
  });

  describe('fail-soft', () => {
    // A malformed response still burned tokens. Not charging them would let a model that always
    // returns junk loop against a ceiling that never moves.
    it('scores 0 but still charges what a malformed response burned', async () => {
      nextResponse = 'not json at all';
      nextUsage = { inputTokens: 1_000, outputTokens: 1_000 };

      expect(await judge()).toEqual({ relevance: 0, costMicroUsd: 1_000 });
    });

    it('scores 0 when the response is JSON of the wrong shape', async () => {
      nextResponse = JSON.stringify({ verdict: 'yes' });
      expect(await judge()).toMatchObject({ relevance: 0 });
    });

    // Null means nothing was even attempted, so there is nothing to charge. The caller counts it as
    // below-relevance either way.
    it('returns null when the model is not in this deployment catalog', async () => {
      expect(await judge({ model: 'a-model-that-does-not-exist' })).toBeNull();
    });

    // The model IS in the catalog here, so the failure is priced (at zero, nothing was sent) rather
    // than reported as "never attempted". Either way the caller counts it as below-relevance.
    it('scores 0 at no cost when the adapter cannot be initialized', async () => {
      llmAvailable = false;
      expect(await judge()).toEqual({ relevance: 0, costMicroUsd: 0 });
    });
  });

  it('sends the run question and candidate through to the model', async () => {
    nextResponse = JSON.stringify({ relevance: 0.5 });
    await judge();
    expect(lastPrompt).toContain('How fast is coastal erosion in Cornwall?');
    expect(lastPrompt).toContain('https://example.com/erosion');
  });

  it('names a default model, so a config that sets none still has a consumer', () => {
    expect(RELEVANCE_JUDGE_DEFAULT_MODEL).toBe(ChatModels.GPT4_1_MINI);
  });
});
