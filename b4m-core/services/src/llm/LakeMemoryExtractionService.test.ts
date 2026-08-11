import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ApiKeyTable } from '@bike4mind/llm-adapters';
import { ChatModels } from '@bike4mind/common';

// Mock the adapters so evaluate()'s getAvailableModels + getLlmByModel resolve to a fake backend whose
// `complete` streams whatever canned response the test sets. Mirrors intentClassifier.test.ts.
let nextResponse = '';
let completeCalls = 0;

vi.mock('@bike4mind/llm-adapters', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/llm-adapters')>('@bike4mind/llm-adapters');
  return {
    ...actual,
    getAvailableModels: async () => [{ id: ChatModels.GPT4_1_MINI }],
    getLlmByModel: () => ({
      complete: async (
        _model: string,
        _messages: unknown,
        _opts: unknown,
        callback: (texts: string[], info?: unknown) => Promise<void>
      ) => {
        completeCalls++;
        await callback([nextResponse], undefined);
      },
    }),
  };
});

// Imported AFTER the mock is registered.
const { LakeMemoryExtractionService, LAKE_FACTS_PER_DOC_MAX } = await import('./LakeMemoryExtractionService');

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

const apiKeyTable = { openai: 'k-openai' } as ApiKeyTable;
const service = new LakeMemoryExtractionService(silentLogger);
const run = (docText: string, docTitle = 'X-200 Pump Spec') => service.evaluate({ apiKeyTable, docTitle, docText });

beforeEach(() => {
  completeCalls = 0;
  nextResponse = '';
});

describe('LakeMemoryExtractionService.evaluate', () => {
  it('parses well-formed facts', async () => {
    nextResponse = JSON.stringify({
      facts: [
        { fact: 'The X-200 pump has a 5-year warranty.', importance: 8 },
        { fact: 'The X-200 pump weighs 4.2 kg.', importance: 5 },
      ],
    });
    const facts = await run('... document text ...');
    expect(facts).toHaveLength(2);
    expect(facts?.[0].fact).toContain('5-year warranty');
  });

  it('caps to the per-doc max, dropping the low-importance tail', async () => {
    // Low-importance facts FIRST in the input, so passing proves an importance sort, not a bare slice.
    const low = Array.from({ length: 5 }, (_, i) => ({ fact: `low ${i}`, importance: 2 }));
    const high = Array.from({ length: LAKE_FACTS_PER_DOC_MAX }, (_, i) => ({ fact: `high ${i}`, importance: 9 }));
    nextResponse = JSON.stringify({ facts: [...low, ...high] });
    const facts = await run('... long document ...');
    expect(facts).toHaveLength(LAKE_FACTS_PER_DOC_MAX);
    expect(facts?.every(f => f.importance === 9)).toBe(true); // the low tail was dropped by the sort+cap
  });

  it('returns null when the document yields no facts', async () => {
    nextResponse = JSON.stringify({ facts: [] });
    expect(await run('a table of contents')).toBeNull();
  });

  it('returns null (fail-soft) on a malformed response', async () => {
    nextResponse = 'not json at all';
    expect(await run('... document ...')).toBeNull();
  });

  it('skips the LLM call entirely for empty document text', async () => {
    expect(await run('   ')).toBeNull();
    expect(completeCalls).toBe(0);
  });
});
