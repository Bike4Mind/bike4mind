/**
 * Regression test for #3253 on OpenAIBackend's /v1/responses path (completeViaResponses,
 * used for the GPT-5 narrator family with tools - see openaiBackend.responsesRouting.test.ts).
 * See anthropicBackend.artifactDedupe.test.ts for the full mechanism.
 *
 * This path never streams a tool's own artifact live via handleToolResultStreaming - the
 * client renders it through a separate services-layer extraction from the recorded tool
 * result instead (see the comment at the markDelivered call site in openaiBackend.ts). It
 * still needs the recursive-echo guard: GPT retains the tool call's own arguments in context
 * and can reconstruct the same <artifact> tag in its synthesis reply, which the reply parser
 * would then render as a second, empty card. `markDelivered` tells the shared guard an
 * artifact was delivered THAT way, without re-sending it, so the guard can still recognize
 * and strip an echo of it.
 */
import { describe, it, expect } from 'vitest';
import { ChatModels, type ICompletionOptionTools } from '@bike4mind/common';
import { OpenAIBackend } from './openaiBackend';

type AnyRecord = Record<string, unknown>;

const MERMAID_ARTIFACT =
  '<artifact identifier="mermaid-1" type="application/vnd.ant.mermaid" title="Flow">graph TD;A-->B</artifact>';

/** The streaming /v1/responses SSE shape: output_text deltas, then a terminal event. */
function responsesEventStream(response: AnyRecord): AsyncIterable<AnyRecord> {
  const events: AnyRecord[] = [];
  for (const item of (response.output as AnyRecord[]) ?? []) {
    if (item.type !== 'message') continue;
    for (const part of (item.content as AnyRecord[]) ?? []) {
      if (part.type === 'output_text') events.push({ type: 'response.output_text.delta', delta: part.text });
    }
  }
  events.push({ type: 'response.completed', response });
  return (async function* () {
    for (const e of events) yield e;
  })();
}

const mermaidTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'mermaid_chart',
    description: 'Generate a Mermaid chart',
    parameters: { type: 'object', properties: { definition: { type: 'string' } }, required: ['definition'] },
  },
  toolFn: async () => MERMAID_ARTIFACT,
};

function captureCb() {
  const calls: Array<{ text: (string | null | undefined)[]; info: unknown }> = [];
  return {
    calls,
    cb: async (text: (string | null | undefined)[], info: unknown) => {
      calls.push({ text, info });
    },
  };
}

function clientText(calls: Array<{ text: (string | null | undefined)[] }>): string {
  return calls
    .flatMap(c => c.text)
    .filter((r): r is string => typeof r === 'string')
    .join('');
}

describe('OpenAIBackend (Responses path) does not duplicate an echoed tool artifact card (#3253)', () => {
  it('strips a synthesis-turn echo of an artifact delivered via completeViaResponses', async () => {
    const backend = new OpenAIBackend('test-key');
    (backend as unknown as { _api: unknown })._api = {
      // Turn 1: responses.create returns a function_call for the artifact-emitting tool.
      responses: {
        create: async () =>
          responsesEventStream({
            output: [
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'mermaid_chart',
                arguments: '{"definition":"graph TD;A-->B"}',
              },
            ],
            usage: { input_tokens: 10, output_tokens: 4 },
          }),
      },
      // Turn 2: non-MCP tools are dropped, so recursion falls through to chat.completions -
      // the model echoes the artifact tag it retains from the tool call's own arguments.
      chat: {
        completions: {
          create: async () => ({
            choices: [
              { index: 0, message: { role: 'assistant', content: `Here is your diagram:\n\n${MERMAID_ARTIFACT}` } },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }),
        },
      },
    };

    const { calls, cb } = captureCb();
    await backend.complete(
      ChatModels.GPT5,
      [{ role: 'user', content: 'a simple process flow diagram' }],
      { tools: [mermaidTool] },
      cb
    );

    const text = clientText(calls);
    // The echoed tag must not reach the client as reply text - it was already delivered via
    // the services-layer tool_result extraction, not this stream.
    expect((text.match(/<artifact\b/g) || []).length).toBe(0);
    expect(text).toContain('Here is your diagram:');
  });

  it('pin: a genuinely NEW artifact the model composes in its own reply text is not mistaken for an echo', async () => {
    const NEW_ARTIFACT =
      '<artifact identifier="mermaid-2" type="application/vnd.ant.mermaid" title="Second">graph TD;C-->D</artifact>';
    const backend = new OpenAIBackend('test-key');
    (backend as unknown as { _api: unknown })._api = {
      responses: {
        create: async () =>
          responsesEventStream({
            output: [
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'mermaid_chart',
                arguments: '{"definition":"graph TD;A-->B"}',
              },
            ],
            usage: { input_tokens: 10, output_tokens: 4 },
          }),
      },
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: `Here's another one I drew myself:\n\n${NEW_ARTIFACT}` },
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }),
        },
      },
    };

    const { calls, cb } = captureCb();
    await backend.complete(
      ChatModels.GPT5,
      [{ role: 'user', content: 'a simple process flow diagram' }],
      { tools: [mermaidTool] },
      cb
    );

    expect(clientText(calls)).toContain('identifier="mermaid-2"');
  });
});
