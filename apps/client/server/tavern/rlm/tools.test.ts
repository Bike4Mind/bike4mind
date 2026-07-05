import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReplSession } from '@bike4mind/agents';
import { buildDataLakeTools } from './tools';

// Mock the Anthropic SDK so subAgentQuery doesn't make real network calls.
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn(async ({ messages }: { messages: Array<{ content: string }> }) => ({
          content: [{ type: 'text', text: `[mock] ${messages[0].content.slice(0, 50)}` }],
          usage: { input_tokens: 100, output_tokens: 30 },
        })),
      };
    },
  };
});

describe('buildDataLakeTools — wiring through ReplContext', () => {
  let session: ReplSession;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    session = new ReplSession({ sessionId: 'tools-test' });
    // Spy on global fetch so HTTP calls return canned JSON
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    // Restore the global fetch spy so it doesn't leak across test files
    fetchSpy.mockRestore();
  });

  it('exposes all five tools as callable async functions in the REPL', async () => {
    const tools = buildDataLakeTools({
      baseUrl: 'http://localhost:3000',
      apiKey: 'test-key',
      anthropicApiKey: 'test-anthropic',
      session,
    });
    session.setTools(tools);

    const r = await session.runCode(`
      const fns = [
        typeof semanticSearch,
        typeof keywordSearch,
        typeof listArticles,
        typeof getArticle,
        typeof subAgentQuery,
      ];
      console.log(fns.join(','));
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('function,function,function,function,function');
  });

  it('semanticSearch posts to the right endpoint and returns the JSON', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ file_id: 'a', file_name: 'A.md', file_tags: [], chunk_text: 'foo', score: 0.9 }],
          total_chunks_searched: 100,
        }),
        { status: 200 }
      )
    );

    const tools = buildDataLakeTools({
      baseUrl: 'http://localhost:3000',
      apiKey: 'k',
      anthropicApiKey: 'a',
      session,
    });
    session.setTools(tools);

    const r = await session.runCode(`
      const out = await semanticSearch({ query: "scheduling", top_k: 5 });
      console.log(out.results[0].file_name + " | " + out.total_chunks_searched);
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('A.md | 100');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe('http://localhost:3000/api/data-lakes/semantic-search');
    expect((call[1] as RequestInit).method).toBe('POST');
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({ query: 'scheduling', top_k: 5, min_score: 0, tags: [] });
  });

  it('subAgentQuery records the call against the session budget', async () => {
    const tools = buildDataLakeTools({
      baseUrl: 'http://localhost:3000',
      apiKey: 'k',
      anthropicApiKey: 'a',
      session,
    });
    session.setTools(tools);

    const r = await session.runCode(`
      const out = await subAgentQuery({ prompt: "Classify this: Hello world" });
      console.log(out);
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toBe('[mock] Classify this: Hello world');

    const u = session.getUsage();
    expect(u.subLlmCalls).toBe(1);
    expect(u.promptTokens).toBe(100);
    expect(u.completionTokens).toBe(30);
    // Cost = 100 * 0.8e-6 + 30 * 4e-6 = 0.00008 + 0.00012 = 0.0002
    expect(u.totalCostUsd).toBeCloseTo(0.0002, 7);
  });

  it('rejects semanticSearch when query is missing', async () => {
    const tools = buildDataLakeTools({
      baseUrl: 'http://localhost:3000',
      apiKey: 'k',
      anthropicApiKey: 'a',
      session,
    });
    session.setTools(tools);

    const r = await session.runCode(`
      try {
        await semanticSearch({});
        console.log("no throw");
      } catch (e) {
        console.log("threw: " + e.message);
      }
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toContain('threw: semanticSearch: query is required');
  });

  it('a multi-step orchestration works: search -> per-result subAgentQuery loop', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { file_id: 'a', file_name: 'A.md', chunk_text: 'foo', score: 0.9 },
            { file_id: 'b', file_name: 'B.md', chunk_text: 'bar', score: 0.85 },
          ],
        }),
        { status: 200 }
      )
    );

    const tools = buildDataLakeTools({
      baseUrl: 'http://localhost:3000',
      apiKey: 'k',
      anthropicApiKey: 'a',
      session,
    });
    session.setTools(tools);

    const r = await session.runCode(`
      const hits = await semanticSearch({ query: "test" });
      classifications = [];
      for (const h of hits.results) {
        const c = await subAgentQuery({ prompt: "Classify: " + h.chunk_text });
        classifications.push({ file: h.file_name, label: c });
      }
      console.log(JSON.stringify(classifications));
    `);
    expect(r.error).toBeNull();
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].file).toBe('A.md');
    expect(parsed[1].file).toBe('B.md');

    // Two sub-LLM calls accounted for in the budget
    expect(session.getUsage().subLlmCalls).toBe(2);
  });
});
