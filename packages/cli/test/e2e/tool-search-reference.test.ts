/**
 * E2E test: deferred tools on native tool search, through the real request path.
 *
 * A REAL ReActAgent drives the REAL ServerLlmBackend (SDK SSE transport) wrapped by
 * buildToolSearch, the wiring index.tsx and AcpServer use. Only the HTTP fetch is faked:
 * it records each completions request body and answers with a scripted SSE turn. The
 * assertions are on those bodies, i.e. exactly what the server receives.
 */

import { describe, expect, it, vi } from 'vitest';
import { PassThrough, Readable } from 'stream';
import { DeferredToolRegistry, ReActAgent, createToolSearchTool } from '@bike4mind/agents';
import { ChatModels, ModelBackend, type IMessage, type ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import type { ApiClient } from '../../src/auth/ApiClient';
import { ServerLlmBackend } from '../../src/llm/ServerLlmBackend';
import { FallbackLlmBackend } from '../../src/llm/FallbackLlmBackend';
import { buildToolSearch } from '../../src/bootstrap/buildToolSearch';

const NATIVE = ChatModels.CLAUDE_5_5_OPUS;
const OPENAI = ChatModels.GPT4o;
const models = [
  { id: NATIVE, backend: ModelBackend.Anthropic },
  { id: OPENAI, backend: ModelBackend.OpenAI },
] as ModelInfo[];

type Turn = { tool?: { name: string; args: Record<string, unknown> }; text?: string; fail?: boolean };
type WireTool = { toolSchema: ICompletionOptionTools['toolSchema'] };
type RequestBody = { model: string; messages: IMessage[]; options: { tools: WireTool[] } };

const schemas = (body: RequestBody) => body.options.tools.map(t => t.toolSchema);

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;

function makeServerBackend(turns: Turn[]) {
  const bodies: RequestBody[] = [];
  const apiClient = {
    baseURL: 'http://localhost:3000',
    fetch: async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const turn = turns[bodies.length - 1];
      if (!turn) throw new Error('script exhausted');
      if (turn.fail) {
        return new Response(JSON.stringify({ error: 'bad request' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      const stream = new PassThrough();
      setTimeout(() => {
        if (turn.tool) {
          const id = `toolu_${bodies.length}`;
          stream.write(
            sse({ type: 'tool_use', tools: [{ name: turn.tool.name, arguments: JSON.stringify(turn.tool.args), id }] })
          );
        } else {
          stream.write(sse({ type: 'content', text: turn.text ?? 'done' }));
        }
        stream.write('data: [DONE]\n\n');
        stream.end();
      }, 0);
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  } as unknown as ApiClient;
  return { llm: new ServerLlmBackend({ apiClient, model: NATIVE, sseCompletionsUrl: '/completions' }), bodies };
}

function deferredTools() {
  const weather = vi.fn(async () => 'sunny');
  const registry = new DeferredToolRegistry();
  registry.register([
    {
      toolSchema: {
        name: 'mcp__weather',
        description: 'Current weather',
        parameters: { type: 'object', properties: {} },
      },
      toolFn: weather,
    },
    {
      toolSchema: { name: 'mcp__stocks', description: 'Stock quotes', parameters: { type: 'object', properties: {} } },
      toolFn: async () => '42',
    },
  ]);
  return { registry, weather };
}

const readFile: ICompletionOptionTools = {
  toolSchema: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
  toolFn: async () => 'contents',
};

function makeAgent(
  llm: ICompletionBackend,
  model: string,
  tools: ICompletionOptionTools[],
  registry: DeferredToolRegistry
) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return new ReActAgent({
    userId: 'e2e-test-user',
    logger: logger as unknown as Logger,
    llm,
    model,
    tools,
    maxIterations: 5,
    systemPrompt: 'You are a test assistant in an e2e harness.',
    unknownToolResolver: async name => registry.get(name) ?? null,
  });
}

/** The CLI agent with buildToolSearch wiring, optionally behind FallbackLlmBackend. */
function cliAgent(turns: Turn[], model: string, fallbackModels: string[] = []) {
  const { llm: server, bodies } = makeServerBackend(turns);
  const { registry, weather } = deferredTools();
  const agentToolsRef: { current: ICompletionOptionTools[] | null } = { current: null };
  const { llm, toolSearchTool } = buildToolSearch({ llm: server, models, registry, agentToolsRef });
  const wrapped = fallbackModels.length > 0 ? new FallbackLlmBackend(llm, fallbackModels, () => {}) : llm;
  const agent = makeAgent(wrapped, model, [readFile, toolSearchTool!], registry);
  agentToolsRef.current = agent.getTools();
  return { agent, bodies, weather };
}

const searchThenCall: Turn[] = [
  { tool: { name: 'tool_search', args: { query: 'select:mcp__weather' } } },
  { tool: { name: 'mcp__weather', args: {} } },
  { text: 'It is sunny.' },
];

const toolResults = (body: RequestBody) =>
  body.messages.flatMap(m =>
    Array.isArray(m.content)
      ? (m.content as Array<{ type: string; content?: unknown }>).filter(b => b.type === 'tool_result')
      : []
  );

describe('deferred tools via tool_reference (real ServerLlmBackend + real ReActAgent)', () => {
  it('keeps the tools array byte-stable across a tool load and answers with tool_reference', async () => {
    const { agent, bodies, weather } = cliAgent(searchThenCall, NATIVE);

    const result = await agent.run('weather?', { parallelExecution: false });

    expect(result.finalAnswer).toBe('It is sunny.');
    expect(bodies).toHaveLength(3);
    const toolsWire = bodies.map(b => JSON.stringify(b.options.tools));
    expect(new Set(toolsWire).size).toBe(1);
    expect(schemas(bodies[0]).map(t => [t.name, t.defer_loading])).toEqual([
      ['read_file', undefined],
      ['tool_search', undefined],
      ['mcp__weather', true],
      ['mcp__stocks', true],
    ]);
    expect(schemas(bodies[0]).some(t => 'cache_control' in t)).toBe(false);
    expect(toolResults(bodies[1])).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'tool_reference', tool_name: 'mcp__weather' }] },
    ]);
    // The loaded tool ran on the first call, not via the "was deferred, retry" fallback.
    expect(weather).toHaveBeenCalledOnce();
    expect(toolResults(bodies[2])[1]).toMatchObject({ tool_use_id: 'toolu_2', content: 'sunny' });
  });

  it('sends exactly the pre-change payloads on a model without native tool search', async () => {
    const { agent, bodies } = cliAgent(searchThenCall, OPENAI);
    await agent.run('weather?', { parallelExecution: false });

    const { llm: server, bodies: baseline } = makeServerBackend(searchThenCall);
    const { registry } = deferredTools();
    const ref: { current: ICompletionOptionTools[] | null } = { current: null };
    const legacyToolSearch = createToolSearchTool({ registry, toolListAccessor: () => ref.current! });
    const legacy = makeAgent(server, OPENAI, [readFile, legacyToolSearch], registry);
    ref.current = legacy.getTools();
    await legacy.run('weather?', { parallelExecution: false });

    expect(JSON.stringify(bodies)).toBe(JSON.stringify(baseline));
    expect(schemas(bodies[0]).some(t => t.defer_loading !== undefined)).toBe(false);
    expect(schemas(bodies[1]).map(t => t.name)).toEqual(['read_file', 'tool_search', 'mcp__weather']);
    expect(String(toolResults(bodies[1])[0].content)).toContain('<functions>');
  });

  it('shapes a mid-run fallback to a model without tool search, and the primary again after', async () => {
    const turns: Turn[] = [searchThenCall[0], { fail: true }, searchThenCall[1], searchThenCall[2]];
    const { agent, bodies, weather } = cliAgent(turns, NATIVE, [OPENAI]);

    const result = await agent.run('weather?', { parallelExecution: false });

    expect(result.finalAnswer).toBe('It is sunny.');
    // FallbackLlmBackend tries the primary first on every request.
    expect(bodies.map(b => b.model)).toEqual([NATIVE, NATIVE, OPENAI, NATIVE]);
    expect(toolResults(bodies[1])[0].content).toEqual([{ type: 'tool_reference', tool_name: 'mcp__weather' }]);
    const onFallback = bodies[2];
    expect(schemas(onFallback).some(t => t.defer_loading !== undefined)).toBe(false);
    expect(schemas(onFallback).map(t => t.name)).toEqual(['read_file', 'tool_search', 'mcp__weather']);
    expect(JSON.stringify(onFallback.messages)).not.toContain('"tool_reference"');
    expect(JSON.stringify(bodies[3].options.tools)).toBe(JSON.stringify(bodies[0].options.tools));
    expect(toolResults(bodies[3])[0].content).toEqual([{ type: 'tool_reference', tool_name: 'mcp__weather' }]);
    expect(weather).toHaveBeenCalledOnce();
  });

  it('carries a native-loaded tool across a /model switch to a model without tool search', async () => {
    const { agent, bodies } = cliAgent(
      [...searchThenCall, { tool: { name: 'mcp__weather', args: {} } }, { text: 'Still sunny.' }],
      NATIVE
    );
    await agent.run('weather?', { parallelExecution: false });
    const history = agent.toCheckpoint().messages.filter(m => m.role !== 'system');

    // What the /model handler does: retarget the agent's model.
    (agent as unknown as { context: { model: string } }).context.model = OPENAI;
    await agent.run('and now?', { parallelExecution: false, previousMessages: history });

    const switched = bodies[3];
    expect(switched.model).toBe(OPENAI);
    expect(schemas(switched).map(t => [t.name, t.defer_loading])).toEqual([
      ['read_file', undefined],
      ['tool_search', undefined],
      ['mcp__weather', undefined],
    ]);
    expect(toolResults(switched)[0].content).toBe(
      'Loaded 1 tool schema(s): mcp__weather. These are now callable in your next message.'
    );
  });
});
