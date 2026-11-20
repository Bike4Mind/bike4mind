/**
 * After a tool round on OpenAI, the follow-up request keeps tools only when a tool
 * failed (once per turn) or an MCP tool ran. Whenever tools are dropped, tool-dependent
 * prompts ("you MUST use tool X") are stripped too, so the model is never told to call a
 * tool it does not have.
 */

import { describe, it, expect } from 'vitest';
import { Stream } from 'openai/streaming';
import { ChatModels, type IMessage } from '@bike4mind/common';
import { OpenAIBackend } from './openaiBackend';
import type { ICompletionOptions, ICompletionOptionTools } from './backend';

type AnyRecord = Record<string, unknown>;
type Round = 'tool' | 'text';
type Path = 'chat' | 'stream' | 'responses';

const MUST_TEXT = 'you MUST use the image_generation tool';

const messages: IMessage[] = [
  { role: 'system', content: MUST_TEXT, requiresTool: 'image_generation' } as IMessage,
  { role: 'user', content: 'generate an image of a red bicycle' },
];

function chatToolCall() {
  return {
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'image_generation', arguments: '{"prompt":"bike"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function chatText() {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function asStream(chunks: AnyRecord[]) {
  const stream = Object.create(Stream.prototype) as Stream<unknown>;
  (stream as unknown as { [Symbol.asyncIterator]: () => AsyncGenerator<unknown> })[Symbol.asyncIterator] =
    async function* () {
      for (const c of chunks) yield c;
    };
  return stream;
}

function streamToolCall() {
  return asStream([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'image_generation', arguments: '{"prompt":"bike"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

function streamText() {
  return asStream([
    { choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

function responsesPayload(round: Round) {
  return round === 'tool'
    ? {
        output: [
          { type: 'function_call', call_id: 'call_1', name: 'image_generation', arguments: '{"prompt":"bike"}' },
        ],
        usage: { input_tokens: 20, output_tokens: 8 },
      }
    : {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
        usage: { input_tokens: 10, output_tokens: 4 },
      };
}

function responsesStream(payload: AnyRecord) {
  return (async function* () {
    yield { type: 'response.completed', response: payload };
  })();
}

interface Call {
  api: 'chat' | 'responses';
  params: AnyRecord;
}

/** Scripts the model's rounds in order, across chat.completions and responses.create. */
function buildBackend(path: Path, rounds: Round[]) {
  const backend = new OpenAIBackend('test-key');
  const calls: Call[] = [];
  const next = () => rounds[calls.length - 1] ?? 'text';
  (backend as unknown as { _api: unknown })._api = {
    chat: {
      completions: {
        create: async (params: AnyRecord) => {
          calls.push({ api: 'chat', params });
          const round = next();
          if (path === 'stream') return round === 'tool' ? streamToolCall() : streamText();
          return round === 'tool' ? chatToolCall() : chatText();
        },
      },
    },
    responses: {
      create: async (params: AnyRecord) => {
        calls.push({ api: 'responses', params });
        return responsesStream(responsesPayload(next()));
      },
    },
  };
  return { backend, calls };
}

/** toolOutcomes[i] is how the i-th tool execution goes: true = succeeds, false = throws. */
function buildTool(toolOutcomes: boolean[]): ICompletionOptionTools {
  let n = 0;
  return {
    toolSchema: {
      name: 'image_generation',
      description: 'Generate an image.',
      parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    },
    toolFn: async () => {
      const ok = toolOutcomes[n++] ?? true;
      if (!ok) throw new Error('flux-pro-1.1-ultra requires a paid plan');
      return 'ok';
    },
  };
}

async function run(path: Path, rounds: Round[], toolOutcomes: boolean[]) {
  const { backend, calls } = buildBackend(path, rounds);
  const options: Partial<ICompletionOptions> = {
    stream: path === 'stream',
    tools: [buildTool(toolOutcomes)],
    ...(path === 'responses' ? { reasoningEffort: 'low' as const } : {}),
  };
  await backend.complete(
    path === 'responses' ? ChatModels.GPT5 : ChatModels.GPT4o,
    messages,
    options,
    async () => undefined
  );
  return calls;
}

const hasTools = (c: Call) => Array.isArray(c.params.tools) && (c.params.tools as unknown[]).length > 0;
const hasMustPrompt = (c: Call) => JSON.stringify(c.params.messages ?? c.params.input).includes(MUST_TEXT);

describe.each<Path>(['chat', 'stream', 'responses'])('OpenAI failed-tool retention (%s path)', path => {
  it('keeps tools and the tool-dependent prompt after a failed built-in tool round', async () => {
    const calls = await run(path, ['tool', 'text'], [false]);

    expect(calls).toHaveLength(2);
    expect(hasTools(calls[1])).toBe(true);
    expect(hasMustPrompt(calls[1])).toBe(true);
    if (path === 'responses') expect(calls[1].api).toBe('responses');
  });

  it('drops tools and strips the tool-dependent prompt after a second consecutive failure', async () => {
    const calls = await run(path, ['tool', 'tool', 'text'], [false, false]);

    expect(calls).toHaveLength(3);
    expect(hasTools(calls[1])).toBe(true);
    expect(hasTools(calls[2])).toBe(false);
    expect(hasMustPrompt(calls[2])).toBe(false);
  });

  it('drops tools and strips the tool-dependent prompt after a retry that succeeds', async () => {
    const calls = await run(path, ['tool', 'tool', 'text'], [false, true]);

    expect(calls).toHaveLength(3);
    expect(hasTools(calls[2])).toBe(false);
    expect(hasMustPrompt(calls[2])).toBe(false);
  });

  it('drops tools and strips the tool-dependent prompt after a successful built-in tool round', async () => {
    const calls = await run(path, ['tool', 'text'], [true]);

    expect(calls).toHaveLength(2);
    expect(hasTools(calls[1])).toBe(false);
    expect(hasMustPrompt(calls[1])).toBe(false);
  });
});
