/**
 * Shared regression suite for the OpenAI-compatible backends that never stream a tool's artifact
 * live (Kimi, xAI, DeepSeek). The client renders an emitter's artifact through the services-layer
 * tool_result extraction, so if the raw `<artifact>` tag also re-enters history the model can echo
 * it and the reply parser renders a second card. See anthropicBackend.artifactDedupe.test.ts for
 * the full mechanism.
 */
import { describe, expect, it, vi } from 'vitest';
import { Stream } from 'openai/streaming';
import { ARTIFACT_DELIVERED_PLACEHOLDER, ARTIFACT_REMOVED_PLACEHOLDER, type IMessage } from '@bike4mind/common';
import type { CompletionInfo, ICompletionBackend, ICompletionOptionTools } from '../backend';

const MERMAID_ARTIFACT =
  '<artifact identifier="mermaid-1" type="application/vnd.ant.mermaid" title="Flow">graph TD;A-->B</artifact>';

const tool = (name: string, output: string): ICompletionOptionTools => ({
  toolSchema: { name, description: name, parameters: { type: 'object', properties: {} } },
  toolFn: async () => output,
});

const throwingTool = (name: string, message: string): ICompletionOptionTools => ({
  toolSchema: { name, description: name, parameters: { type: 'object', properties: {} } },
  toolFn: async () => {
    throw new Error(message);
  },
});

const toolCallTurn = (name: string, stream: boolean) =>
  stream
    ? [
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name, arguments: '{}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ]
    : {
        choices: [
          {
            index: 0,
            message: {
              content: '',
              tool_calls: [{ id: 't1', type: 'function', function: { name, arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };

const answerTurn = (stream: boolean) =>
  stream
    ? [
        {
          choices: [{ index: 0, delta: { content: 'Here is your diagram.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 6 },
        },
      ]
    : {
        choices: [{ index: 0, message: { content: 'Here is your diagram.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      };

async function runToolTurn(
  backend: ICompletionBackend,
  model: string,
  toolDef: ICompletionOptionTools,
  stream: boolean
) {
  const toolName = toolDef.toolSchema.name;
  const requests: string[] = [];
  const turns = [toolCallTurn(toolName, stream), answerTurn(stream)];
  const create = vi.fn().mockImplementation(async (params: unknown) => {
    // Serialized now: the backend keeps mutating the same messages array across turns.
    requests.push(JSON.stringify(params));
    const turn = turns[Math.min(requests.length - 1, turns.length - 1)];
    if (!stream) return turn;
    const chunks = turn as unknown[];
    // The backends branch on `response instanceof Stream`, so wrap the generator in a real one.
    const iterator = () =>
      (async function* () {
        for (const c of chunks) yield c;
      })();
    return new Stream(iterator as never, new AbortController());
  });
  // The client is private; swapping it keeps this a unit test.
  (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };

  let lastInfo: CompletionInfo | undefined;
  await backend.complete(
    model,
    [{ role: 'user', content: 'a simple process flow diagram' } as IMessage],
    { stream, tools: [toolDef] },
    async (_results, info) => {
      if (info) lastInfo = info;
    }
  );
  return { requests, toolsUsed: lastInfo?.toolsUsed };
}

export function describeOpenAICompatibleArtifactDedupe(
  label: string,
  makeBackend: () => ICompletionBackend,
  model: string
) {
  describe(`${label} does not feed tool artifact markup back to the model`, () => {
    for (const stream of [true, false]) {
      const mode = stream ? 'streaming' : 'non-streaming';

      it(`replaces an emitter's artifact with the delivered placeholder in history (${mode})`, async () => {
        const { requests, toolsUsed } = await runToolTurn(
          makeBackend(),
          model,
          tool('mermaid_chart', MERMAID_ARTIFACT),
          stream
        );

        expect(requests).toHaveLength(2);
        expect(requests[1]).not.toContain('<artifact');
        expect(requests[1]).toContain(ARTIFACT_DELIVERED_PLACEHOLDER);
        expect(toolsUsed?.[0]?.returnValue).toBe(ARTIFACT_DELIVERED_PLACEHOLDER);
      });

      it(`replaces a non-emitter's artifact markup with the removed placeholder (${mode})`, async () => {
        const { requests } = await runToolTurn(
          makeBackend(),
          model,
          tool('web_fetch', `page text ${MERMAID_ARTIFACT} more text`),
          stream
        );

        expect(requests[1]).not.toContain('<artifact');
        expect(requests[1]).toContain(`page text ${ARTIFACT_REMOVED_PLACEHOLDER} more text`);
      });

      it(`replaces artifact markup in a thrown tool error with the removed placeholder (${mode})`, async () => {
        const { requests } = await runToolTurn(
          makeBackend(),
          model,
          throwingTool('mermaid_chart', `bad ${MERMAID_ARTIFACT}`),
          stream
        );

        expect(requests[1]).not.toContain('<artifact');
        expect(requests[1]).toContain(ARTIFACT_REMOVED_PLACEHOLDER);
      });
    }
  });
}
