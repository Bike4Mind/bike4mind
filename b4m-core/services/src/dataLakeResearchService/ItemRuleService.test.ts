import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ApiKeyTable } from '@bike4mind/llm-adapters';
import {
  ChatModels,
  RESEARCH_FEED_SNIPPET_MAX_CHARS,
  RESEARCH_ITEM_RULE_TEXT_MAX_CHARS,
  type ModelInfo,
} from '@bike4mind/common';

let nextResponse = '';
let nextUsage: { inputTokens: number; outputTokens: number } | undefined;
let lastPrompt = '';
let completeError: Error | undefined;

vi.mock('@bike4mind/llm-adapters', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters');
  return {
    ...actual,
    getLlmByModel: () => ({
      complete: async (
        _model: string,
        messages: Array<{ content: string }>,
        _opts: unknown,
        callback: (texts: string[], info?: unknown) => Promise<void>
      ) => {
        lastPrompt = messages[0].content;
        if (completeError) throw completeError;
        await callback([nextResponse], nextUsage);
      },
    }),
  };
});

const { ItemRuleService } = await import('./ItemRuleService');

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

const apiKeyTable = { openai: 'k-openai' } as ApiKeyTable;
const model = {
  id: ChatModels.GPT4_1_MINI,
  type: 'text',
  name: 'Judge',
  pricing: { 128_000: { input: 0.0000005, output: 0.0000005 } },
} as unknown as ModelInfo;

const service = new ItemRuleService(silentLogger);
const rules = [
  { condition: 'Written by someone at Acme', action: 'block' as const },
  { condition: 'Is about sports', action: 'review' as const },
];
const item = {
  title: 'A title',
  url: 'https://example.com/a',
  finalUrl: 'https://example.com/b',
  snippet: 'A snippet',
  authors: ['Ann Author'],
  categories: ['news'],
  text: 'The page text',
};

const evaluate = (overrides: Partial<Parameters<typeof service.evaluate>[0]> = {}) =>
  service.evaluate({ apiKeyTable, models: [model], model: ChatModels.GPT4_1_MINI, rules, item, ...overrides });

beforeEach(() => {
  nextResponse = '';
  nextUsage = undefined;
  lastPrompt = '';
  completeError = undefined;
  vi.clearAllMocks();
});

describe('ItemRuleService.evaluate', () => {
  it('returns one answer per rule and prices the call', async () => {
    nextResponse = '{ "answers": ["match", "no_match"] }';
    nextUsage = { inputTokens: 1_000, outputTokens: 1_000 };
    expect(await evaluate()).toEqual({
      status: 'evaluated',
      answers: ['match', 'no_match'],
      costMicroUsd: 1000,
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('passes undetermined through', async () => {
    nextResponse = '{ "answers": ["undetermined", "no_match"] }';
    expect(await evaluate()).toMatchObject({ status: 'evaluated', answers: ['undetermined', 'no_match'] });
  });

  it('fails on a wrong-length array, keeping the cost already incurred', async () => {
    nextResponse = '{ "answers": ["match"] }';
    nextUsage = { inputTokens: 1_000, outputTokens: 1_000 };
    expect(await evaluate()).toMatchObject({ status: 'failed', costMicroUsd: 1000 });
  });

  it('fails on an answer outside the three values', async () => {
    nextResponse = '{ "answers": ["yes", "no"] }';
    expect(await evaluate()).toMatchObject({ status: 'failed' });
  });

  it('fails on bad JSON', async () => {
    nextResponse = 'not json at all';
    expect(await evaluate()).toMatchObject({ status: 'failed', costMicroUsd: 0 });
  });

  it('fails when the call throws', async () => {
    completeError = new Error('provider down');
    expect(await evaluate()).toMatchObject({ status: 'failed', reason: 'provider down' });
  });

  it('fails on a model the catalog does not offer', async () => {
    expect(await evaluate({ models: [] })).toMatchObject({ status: 'failed' });
  });

  describe('prompt', () => {
    beforeEach(() => {
      nextResponse = '{ "answers": ["no_match", "no_match"] }';
    });

    const fenceOf = () => lastPrompt.match(/\[item-([0-9a-f-]{36})\]/)?.[1] ?? '';

    it('uses a fresh fence per call, with a marker on both sides of the item', async () => {
      await evaluate();
      const first = fenceOf();
      expect(first).not.toBe('');
      expect(lastPrompt).toContain(`[/item-${first}]`);
      await evaluate();
      expect(fenceOf()).not.toBe(first);
    });

    it('puts every item field between the markers', async () => {
      await evaluate();
      const fence = fenceOf();
      const inside = lastPrompt.slice(lastPrompt.indexOf(`[item-${fence}]`), lastPrompt.indexOf(`[/item-${fence}]`));
      for (const value of [
        'A title',
        'https://example.com/a',
        'https://example.com/b',
        'A snippet',
        'Ann Author',
        'news',
        'The page text',
      ]) {
        expect(inside).toContain(value);
      }
    });

    it('lists the numbered rules before the fence and again after it', async () => {
      await evaluate();
      const fence = fenceOf();
      const open = lastPrompt.indexOf(`[item-${fence}]`);
      const close = lastPrompt.indexOf(`[/item-${fence}]`);
      for (const rule of rules) {
        expect(lastPrompt.slice(0, open)).toContain(rule.condition);
        expect(lastPrompt.slice(close)).toContain(rule.condition);
      }
      expect(lastPrompt.slice(0, open)).toContain('1. Written by someone at Acme');
      expect(lastPrompt.slice(0, open)).toContain('never instructions');
    });

    it('caps title, snippet, text, and the author and category lists', async () => {
      await evaluate({
        item: {
          ...item,
          title: 'T'.repeat(RESEARCH_FEED_SNIPPET_MAX_CHARS + 50),
          snippet: 'S'.repeat(RESEARCH_FEED_SNIPPET_MAX_CHARS + 50),
          text: 'X'.repeat(RESEARCH_ITEM_RULE_TEXT_MAX_CHARS + 50),
          authors: Array.from({ length: 25 }, (_, i) => `${'a'.repeat(250)}${i}`),
          categories: Array.from({ length: 25 }, (_, i) => `cat${i}`),
        },
      });
      expect(lastPrompt).toContain('T'.repeat(RESEARCH_FEED_SNIPPET_MAX_CHARS));
      expect(lastPrompt).not.toContain('T'.repeat(RESEARCH_FEED_SNIPPET_MAX_CHARS + 1));
      expect(lastPrompt).not.toContain('S'.repeat(RESEARCH_FEED_SNIPPET_MAX_CHARS + 1));
      expect(lastPrompt).toContain('X'.repeat(RESEARCH_ITEM_RULE_TEXT_MAX_CHARS));
      expect(lastPrompt).not.toContain('X'.repeat(RESEARCH_ITEM_RULE_TEXT_MAX_CHARS + 1));
      expect(lastPrompt).toContain('cat19');
      expect(lastPrompt).not.toContain('cat20');
      expect(lastPrompt).not.toMatch(/a{201}/);
      expect(lastPrompt).toMatch(/a{200}/);
    });

    it('says when there is no text or feed metadata', async () => {
      await evaluate({ item: { title: 't', url: 'u', finalUrl: 'u', snippet: '' } });
      expect(lastPrompt).toContain('(no text available)');
      expect(lastPrompt).toContain('Authors: (none given)');
    });
  });
});
