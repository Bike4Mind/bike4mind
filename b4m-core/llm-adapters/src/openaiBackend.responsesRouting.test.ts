/**
 * Locks in the /v1/responses routing (Option 1).
 *
 * The base GPT-5 narrator family (gpt-5 / -mini / -nano / 5.1 / 5.2) silently narrates
 * tool calls on /v1/chat/completions instead of emitting real tool_calls. When
 * function tools are present, the adapter routes those turns to OpenAI's Responses API
 * (`RESPONSES_API_TOOL_MODELS`), where reasoning + tools work together and
 * `reasoning_effort` is preserved.
 *
 * Asserted:
 *  - GPT-5 + tools            -> responses.create (NOT chat.completions); reasoning kept; flat tools; input translated
 *  - GPT-5 + tools, function_call returned -> toolFn executes, then recursion synthesizes via chat.completions
 *  - GPT-5 + tools, executeTools:false -> responses.create called, toolFn NOT run, tool reported
 *  - GPT-4o + tools           -> NOT routed (chat.completions only)
 *  - GPT-5, no tools          -> NOT routed (chat.completions only)
 */

import { describe, it, expect, vi } from 'vitest';
import { ChatModels, type ICompletionOptions, type ICompletionOptionTools } from '@bike4mind/common';
import { OpenAIBackend } from './openaiBackend';

type AnyRecord = Record<string, unknown>;

/** A terminal Responses payload (assistant text, no tool calls). */
function terminalResponse(text = 'All set.') {
  return {
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 10, output_tokens: 4 },
  };
}

/** A Responses payload that requests one function call. */
function functionCallResponse(name: string, args: AnyRecord, callId = 'call_1') {
  return {
    output: [{ type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }],
    usage: { input_tokens: 20, output_tokens: 8 },
  };
}

/** A terminal Chat Completions payload (used for the post-tool synthesis turn). */
function terminalChatCompletion(content = 'Loaded the problem.') {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  };
}

function buildBackend(opts?: {
  responses?: Array<AnyRecord>; // queued responses.create return values (FIFO)
  chat?: Array<AnyRecord>; // queued chat.completions.create return values (FIFO)
}) {
  const backend = new OpenAIBackend('test-key');
  const responsesQueue = [...(opts?.responses ?? [terminalResponse()])];
  const chatQueue = [...(opts?.chat ?? [terminalChatCompletion()])];

  const responsesCreate = vi.fn(async (_params: AnyRecord) => responsesQueue.shift() ?? terminalResponse());
  const chatCreate = vi.fn(async (_params: AnyRecord) => chatQueue.shift() ?? terminalChatCompletion());

  (backend as unknown as { _api: unknown })._api = {
    responses: { create: responsesCreate },
    chat: { completions: { create: chatCreate } },
  };
  return { backend, responsesCreate, chatCreate };
}

const sampleTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'optihashi_formulate',
    description: 'Formulate an optimization problem.',
    parameters: {
      type: 'object',
      properties: { description: { type: 'string' } },
      required: ['description'],
    },
  },
};

async function run(
  backend: OpenAIBackend,
  model: string,
  options: Partial<ICompletionOptions>
): Promise<Array<{ text: (string | null | undefined)[]; info: unknown }>> {
  const emits: Array<{ text: (string | null | undefined)[]; info: unknown }> = [];
  await backend.complete(model, [{ role: 'user', content: 'hi' }], options, async (text, info) => {
    emits.push({ text, info });
  });
  return emits;
}

describe('OpenAIBackend /v1/responses routing for GPT-5 narrator family + tools', () => {
  it('routes GPT-5 + tools to responses.create (not chat.completions), keeping reasoning + translating tools/input', async () => {
    const { backend, responsesCreate, chatCreate } = buildBackend();

    await run(backend, ChatModels.GPT5, { tools: [sampleTool], reasoningEffort: 'medium' });

    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).not.toHaveBeenCalled();

    const params = responsesCreate.mock.calls[0][0] as AnyRecord;
    // reasoning_effort is KEPT on the Responses path (the whole point).
    expect(params.reasoning).toEqual({ effort: 'medium' });
    // Flat function-tool shape (not chat's nested { function: {...} }).
    const tools = params.tools as Array<AnyRecord>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: 'function', name: 'optihashi_formulate' });
    expect(tools[0]).not.toHaveProperty('function');
    // input is an array of items (translated messages), and a system item is present.
    const input = params.input as Array<AnyRecord>;
    expect(Array.isArray(input)).toBe(true);
    expect(input.some(i => i.role === 'system')).toBe(true);
    expect(input.some(i => i.role === 'user')).toBe(true);
  });

  it('executes a returned function_call, then synthesizes via chat.completions on recursion', async () => {
    const toolCalls: AnyRecord[] = [];
    const executingTool: ICompletionOptionTools = {
      ...sampleTool,
      toolFn: async (params: Record<string, unknown>) => {
        toolCalls.push(params);
        return 'FORMULATED_OK';
      },
    };

    const { backend, responsesCreate, chatCreate } = buildBackend({
      responses: [functionCallResponse('optihashi_formulate', { description: 'bike shop, 4 jobs' })],
      chat: [terminalChatCompletion('Loaded the problem.')],
    });

    const emits = await run(backend, ChatModels.GPT5, { tools: [executingTool], reasoningEffort: 'low' });

    // Tool actually executed with parsed args (this is what was broken on chat.completions).
    expect(toolCalls).toEqual([{ description: 'bike shop, 4 jobs' }]);
    // First turn via Responses, synthesis turn via chat.completions (tools dropped => not re-routed).
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);
    // Terminal emit carries the synthesized text and records the tool used.
    const last = emits.at(-1)!;
    expect(last.text).toContain('Loaded the problem.');
    expect((last.info as { toolsUsed?: Array<{ name: string }> }).toolsUsed?.[0]?.name).toBe('optihashi_formulate');
  });

  it('with executeTools:false, reports the call via Responses without running the tool', async () => {
    const toolCalls: AnyRecord[] = [];
    const executingTool: ICompletionOptionTools = {
      ...sampleTool,
      toolFn: async (params: Record<string, unknown>) => {
        toolCalls.push(params);
        return 'FORMULATED_OK';
      },
    };
    const { backend, responsesCreate, chatCreate } = buildBackend({
      responses: [functionCallResponse('optihashi_formulate', { description: 'x' })],
    });

    const emits = await run(backend, ChatModels.GPT5, {
      tools: [executingTool],
      executeTools: false,
      reasoningEffort: 'low',
    });

    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).not.toHaveBeenCalled();
    expect(toolCalls).toEqual([]); // not executed
    expect((emits.at(-1)!.info as { toolsUsed?: Array<{ name: string }> }).toolsUsed?.[0]?.name).toBe(
      'optihashi_formulate'
    );
  });

  it('maps a forced-function tool_choice on turn 1 and reverts to auto on the Responses recursion', async () => {
    // MCP tool keeps tools alive on recursion, so the synthesis turn re-routes to Responses
    // (rather than falling through to chat.completions) - lets us assert both turns' tool_choice.
    const mcpTool: ICompletionOptionTools = {
      ...sampleTool,
      _isMcpTool: true,
      toolFn: async () => 'FORMULATED_OK',
    };
    const { backend, responsesCreate } = buildBackend({
      responses: [functionCallResponse('optihashi_formulate', { description: 'x' }), terminalResponse('done')],
    });

    await run(backend, ChatModels.GPT5, {
      tools: [mcpTool],
      tool_choice: { type: 'function', function: { name: 'optihashi_formulate' } },
      reasoningEffort: 'low',
    });

    expect(responsesCreate).toHaveBeenCalledTimes(2);
    // Turn 1: the chat-shaped forced function maps to the Responses shape.
    expect((responsesCreate.mock.calls[0][0] as AnyRecord).tool_choice).toEqual({
      type: 'function',
      name: 'optihashi_formulate',
    });
    // Turn 2 (post-tool recursion): reverts to 'auto' so the model synthesizes.
    expect((responsesCreate.mock.calls[1][0] as AnyRecord).tool_choice).toBe('auto');
  });

  it('does NOT route non-reasoning models (gpt-4o) with tools — stays on chat.completions', async () => {
    const { backend, responsesCreate, chatCreate } = buildBackend();

    await run(backend, ChatModels.GPT4o, { tools: [sampleTool] });

    expect(responsesCreate).not.toHaveBeenCalled();
    expect(chatCreate).toHaveBeenCalledTimes(1);
  });

  it('does NOT route GPT-5 when no tools are present — stays on chat.completions', async () => {
    const { backend, responsesCreate, chatCreate } = buildBackend();

    await run(backend, ChatModels.GPT5, { reasoningEffort: 'medium' });

    expect(responsesCreate).not.toHaveBeenCalled();
    expect(chatCreate).toHaveBeenCalledTimes(1);
  });
});
