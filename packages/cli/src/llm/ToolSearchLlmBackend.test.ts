import { describe, expect, it, vi } from 'vitest';
import { DeferredToolRegistry } from '@bike4mind/agents';
import { ChatModels, ModelBackend, type IMessage, type ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptions, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { FallbackLlmBackend } from './FallbackLlmBackend';
import { modelServesToolReference, prepareToolSearchRequest, ToolSearchLlmBackend } from './ToolSearchLlmBackend';

const NATIVE = ChatModels.CLAUDE_5_5_OPUS;
const BEDROCK = ChatModels.CLAUDE_5_5_OPUS_BEDROCK;
const OPENAI = ChatModels.GPT4o;

const models = [
  { id: NATIVE, backend: ModelBackend.Anthropic },
  { id: BEDROCK, backend: ModelBackend.Bedrock },
  { id: OPENAI, backend: ModelBackend.OpenAI },
  { id: ChatModels.CLAUDE_4_1_OPUS, backend: ModelBackend.Anthropic },
] as ModelInfo[];

const makeTool = (name: string): ICompletionOptionTools => ({
  toolSchema: { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } },
  toolFn: async () => `${name} ran`,
});

function setup() {
  const registry = new DeferredToolRegistry();
  registry.register([makeTool('mcp__a'), makeTool('mcp__b'), makeTool('mcp__c')]);
  const tools = [makeTool('read_file'), makeTool('tool_search')];
  return { registry, tools };
}

const references = (...toolNames: string[]) =>
  toolNames.map(tool_name => ({ type: 'tool_reference' as const, tool_name }));

function toolSearchTurn(id: string, result: string): IMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'tool_search', input: { query: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] },
  ];
}

const resultContent = (messages: IMessage[], index: number) =>
  (messages[index].content as Array<{ content: unknown }>)[0].content;

const wire = (tools: ICompletionOptionTools[]) => JSON.stringify(tools.map(t => t.toolSchema));

describe('modelServesToolReference', () => {
  it('is true for a Claude model with tool search, direct or Bedrock-served', () => {
    expect(modelServesToolReference(models, NATIVE)).toBe(true);
    expect(modelServesToolReference(models, BEDROCK)).toBe(true);
  });

  it.each([
    ['a non-Anthropic model', OPENAI],
    ['an older Claude', ChatModels.CLAUDE_4_1_OPUS],
    ['a model missing from the list', 'unknown-model'],
  ])('is false for %s', (_label, id) => {
    expect(modelServesToolReference(models, id)).toBe(false);
  });

  it('is false when the model row carries no backend (the offline fallback list)', () => {
    expect(modelServesToolReference([{ id: NATIVE, name: 'Opus' } as ModelInfo], NATIVE)).toBe(false);
  });
});

describe('prepareToolSearchRequest', () => {
  const messages: IMessage[] = [{ role: 'user', content: 'hi' }];

  it('passes a request without tool_search through untouched', () => {
    const { registry } = setup();
    const request = { messages, tools: [makeTool('read_file')] };
    expect(prepareToolSearchRequest(request, registry, true)).toBe(request);
  });

  it('passes the request through when no tools are deferred', () => {
    const { tools } = setup();
    const request = { messages, tools };
    expect(prepareToolSearchRequest(request, new DeferredToolRegistry(), true)).toBe(request);
  });

  it('adds every deferred tool with defer_loading on a native model, and only those', () => {
    const { registry, tools } = setup();
    const prepared = prepareToolSearchRequest({ messages, tools }, registry, true);
    expect(prepared.tools.map(t => [t.toolSchema.name, t.toolSchema.defer_loading])).toEqual([
      ['read_file', undefined],
      ['tool_search', undefined],
      ['mcp__a', true],
      ['mcp__b', true],
      ['mcp__c', true],
    ]);
    expect(prepared.messages).toBe(messages);
    expect(registry.get('mcp__a')?.toolSchema.defer_loading).toBeUndefined();
  });

  it('strips cache_control from a deferred tool', () => {
    const registry = new DeferredToolRegistry();
    const cached = makeTool('mcp__cached');
    (cached.toolSchema as Record<string, unknown>).cache_control = { type: 'ephemeral' };
    registry.register([cached]);
    const { tools } = setup();
    const prepared = prepareToolSearchRequest({ messages, tools }, registry, true).tools;
    const deferred = prepared[prepared.length - 1];
    expect(deferred.toolSchema).not.toHaveProperty('cache_control');
    expect(deferred.toolSchema.defer_loading).toBe(true);
  });

  it('keeps the tools array byte-identical across a tool load', () => {
    const { registry, tools } = setup();
    const before = prepareToolSearchRequest({ messages, tools }, registry, true);

    const liveAfterLoad = [...tools, registry.get('mcp__b')!];
    const history = [...messages, ...toolSearchTurn('toolu_1', JSON.stringify(references('mcp__b')))];
    const after = prepareToolSearchRequest({ messages: history, tools: liveAfterLoad }, registry, true);

    expect(wire(after.tools)).toBe(wire(before.tools));
    expect(resultContent(after.messages, 2)).toEqual(references('mcp__b'));
  });

  it('converts only tool_search results, and leaves the stored history as text', () => {
    const { registry, tools } = setup();
    const serialized = JSON.stringify(references('mcp__a'));
    const history: IMessage[] = [
      ...toolSearchTurn('toolu_1', serialized),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: serialized }] },
    ];
    const prepared = prepareToolSearchRequest({ messages: history, tools }, registry, true);
    expect(resultContent(prepared.messages, 1)).toEqual(references('mcp__a'));
    expect(resultContent(prepared.messages, 3)).toBe(serialized);
    expect(resultContent(history, 1)).toBe(serialized);
  });

  it('sends only the fields a tool_reference block may carry', () => {
    const { registry, tools } = setup();
    const serialized = '[{"type":"tool_reference","tool_name":"mcp__a","extra":1}]';
    const prepared = prepareToolSearchRequest(
      { messages: toolSearchTurn('toolu_1', serialized), tools },
      registry,
      true
    );
    expect(resultContent(prepared.messages, 1)).toEqual(references('mcp__a'));
  });

  it('leaves a reference to a tool no longer offered as text', () => {
    const { registry, tools } = setup();
    const serialized = JSON.stringify(references('mcp__gone'));
    const prepared = prepareToolSearchRequest(
      { messages: toolSearchTurn('toolu_1', serialized), tools },
      registry,
      true
    );
    expect(resultContent(prepared.messages, 1)).toBe(serialized);
  });

  it('keeps the references that still resolve when one of them is gone', () => {
    const { registry, tools } = setup();
    const prepared = prepareToolSearchRequest(
      { messages: toolSearchTurn('toolu_1', JSON.stringify(references('mcp__a', 'mcp__gone'))), tools },
      registry,
      true
    );
    expect(resultContent(prepared.messages, 1)).toEqual(references('mcp__a'));
    const loaded = prepared.tools.find(t => t.toolSchema.name === 'mcp__a');
    expect(loaded?.toolSchema.defer_loading).toBe(true);
    expect(wire(prepared.tools)).toBe(wire(prepareToolSearchRequest({ messages, tools }, registry, true).tools));
  });

  it('sends a deferred tool loaded without a reference non-deferred, so it stays callable', () => {
    const { registry, tools } = setup();
    const live = [...tools, registry.get('mcp__c')!];
    const prepared = prepareToolSearchRequest({ messages, tools: live }, registry, true);
    expect(prepared.tools.find(t => t.toolSchema.name === 'mcp__c')?.toolSchema.defer_loading).toBeUndefined();
    expect(prepared.tools.find(t => t.toolSchema.name === 'mcp__a')?.toolSchema.defer_loading).toBe(true);
  });

  it('always leaves at least one tool non-deferred', () => {
    const registry = new DeferredToolRegistry();
    registry.register([makeTool('tool_search')]);
    const request = {
      messages: toolSearchTurn('toolu_1', JSON.stringify(references('tool_search'))),
      tools: [makeTool('tool_search')],
    };
    expect(prepareToolSearchRequest(request, registry, true)).toBe(request);
  });

  it('leaves a non-native request identical when history holds no references', () => {
    const { registry, tools } = setup();
    const request = { messages: toolSearchTurn('toolu_1', 'Loaded 1 new tool schema(s).'), tools };
    expect(prepareToolSearchRequest(request, registry, false)).toBe(request);
  });

  it('turns references into text on a non-native model and keeps the tools as they are', () => {
    const { registry, tools } = setup();
    const request = { messages: toolSearchTurn('toolu_1', JSON.stringify(references('mcp__a', 'mcp__b'))), tools };
    const prepared = prepareToolSearchRequest(request, registry, false);
    expect(resultContent(prepared.messages, 1)).toBe(
      'Loaded 2 tool schema(s): mcp__a, mcp__b. These are now callable in your next message.'
    );
    expect(prepared.tools).toBe(tools);
  });
});

function innerBackend() {
  const calls: Array<{ model: string; messages: IMessage[]; options: Partial<ICompletionOptions> }> = [];
  const inner: ICompletionBackend = {
    currentModel: NATIVE,
    complete: vi.fn(async (model, messages, options, callback) => {
      calls.push({ model, messages, options });
      await callback(['ok'], {});
    }),
    pushToolMessages: vi.fn(),
    getModelInfo: vi.fn(async () => models),
  };
  return { inner, calls };
}

describe('ToolSearchLlmBackend', () => {
  const messages: IMessage[] = [{ role: 'user', content: 'hi' }];
  const noop = async () => undefined;

  it('passes a request without tool_search through with the same options', async () => {
    const { registry } = setup();
    const { inner, calls } = innerBackend();
    const backend = new ToolSearchLlmBackend(inner, registry, models);
    const options = { tools: [makeTool('read_file')] };

    await backend.complete(NATIVE, messages, options, noop);

    expect(calls[0].options).toBe(options);
    expect(calls[0].messages).toBe(messages);
    expect(backend.servesToolReference()).toBe(false);
  });

  it('defers tools on a supported model and stops on an unsupported one mid-session', async () => {
    const { registry, tools } = setup();
    const { inner, calls } = innerBackend();
    const backend = new ToolSearchLlmBackend(inner, registry, models);

    await backend.complete(NATIVE, messages, { tools }, noop);
    expect(backend.servesToolReference()).toBe(true);
    expect(calls[0].options.tools).toHaveLength(5);

    const options = { tools };
    await backend.complete(OPENAI, messages, options, noop);
    expect(backend.servesToolReference()).toBe(false);
    expect(calls[1].options).toBe(options);

    await backend.complete(NATIVE, messages, { tools }, noop);
    expect(backend.servesToolReference()).toBe(true);
  });

  it('shapes each fallback attempt for the model it goes to', async () => {
    const { registry, tools } = setup();
    const { inner, calls } = innerBackend();
    vi.mocked(inner.complete).mockImplementationOnce(async (model, msgs, options) => {
      calls.push({ model, messages: msgs, options });
      throw new Error('rate limited');
    });
    const toolSearchLlm = new ToolSearchLlmBackend(inner, registry, models);
    const fallback = new FallbackLlmBackend(toolSearchLlm, [OPENAI], () => {});
    const history = toolSearchTurn('toolu_1', JSON.stringify(references('mcp__a')));

    await fallback.complete(NATIVE, history, { tools: [...tools, registry.get('mcp__a')!] }, noop);

    expect(calls.map(c => c.model)).toEqual([NATIVE, OPENAI]);
    expect(resultContent(calls[0].messages, 1)).toEqual(references('mcp__a'));
    expect(calls[1].options.tools?.some(t => t.toolSchema.defer_loading)).toBe(false);
    expect(resultContent(calls[1].messages, 1)).toMatch(/^Loaded 1 tool schema\(s\): mcp__a/);
    expect(toolSearchLlm.servesToolReference()).toBe(false);
  });

  it('treats a Claude model without tool search as non-native: unchanged tools, references as text', async () => {
    const { registry, tools } = setup();
    const { inner, calls } = innerBackend();
    const backend = new ToolSearchLlmBackend(inner, registry, models);
    const history = toolSearchTurn('toolu_1', JSON.stringify(references('mcp__a')));

    await backend.complete(ChatModels.CLAUDE_4_1_OPUS, history, { tools }, noop);

    expect(backend.servesToolReference()).toBe(false);
    expect(calls[0].options).toEqual({ tools });
    expect(resultContent(calls[0].messages, 1)).toMatch(/^Loaded 1 tool schema\(s\): mcp__a/);
  });

  it('delegates currentModel, pushToolMessages and getModelInfo', async () => {
    const { registry } = setup();
    const { inner } = innerBackend();
    const backend = new ToolSearchLlmBackend(inner, registry, models);

    backend.currentModel = OPENAI;
    expect(inner.currentModel).toBe(OPENAI);
    const thinking = [{ type: 'thinking' }];
    backend.pushToolMessages([], { name: 't', id: '1', parameters: '{}' }, 'r', thinking);
    expect(inner.pushToolMessages).toHaveBeenCalledWith([], { name: 't', id: '1', parameters: '{}' }, 'r', thinking);
    expect(await backend.getModelInfo()).toBe(models);
  });
});
