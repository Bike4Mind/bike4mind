import { describe, it, expect } from 'vitest';
import { GeminiBackend } from './geminiBackend';
import type { IMessage } from '@bike4mind/common';

/**
 * Shape mirrors b4m-core/utils/src/llm/utils.ts's Priority 2 tool-pairing reconstruction
 * (fetchAndProcessPreviousMessages), which builds this assistant tool_use / user tool_result
 * pair from promptMeta.functionCalls[].returnValue - the field this repo's backends only
 * recently started writing. Gemini has no shared converter (messageFormatConverter.ts covers
 * OpenAI/xAI/Kimi only); its own formatMessagesIntoGeminiContent does the functionCall /
 * functionResponse mapping, so it needs its own confirmation that replayed history round-trips.
 */
describe('GeminiBackend - replayed tool history (utils.ts Priority 2 shape)', () => {
  it('converts a reconstructed tool_use/tool_result pair into functionCall/functionResponse parts', async () => {
    const backend = new GeminiBackend('test-key');
    let capturedRequest: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      models: {
        generateContentStream: async (request: unknown) => {
          capturedRequest = request;
          return (async function* () {
            yield {
              candidates: [{ content: { parts: [{ text: 'ok' }] } }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            };
          })();
        },
      },
    };

    const assistantMessage: IMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reply 1' },
        { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'weather' } },
      ],
    } as IMessage;
    const toolResultMessage: IMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny', is_error: false }],
    } as IMessage;

    await backend.complete(
      'gemini-2.5-flash' as never,
      [assistantMessage, toolResultMessage, { role: 'user', content: 'and tomorrow?' }],
      { stream: true },
      async () => {}
    );

    const contents = capturedRequest.contents;
    const assistantContent = contents.find((c: any) => c.role === 'model');
    expect(assistantContent.parts.some((p: any) => p.functionCall?.name === 'web_search')).toBe(true);

    const toolResultContent = contents.find((c: any) => c.parts?.[0]?.functionResponse);
    expect(toolResultContent.parts[0].functionResponse).toMatchObject({
      name: 'web_search',
      response: { result: 'sunny' },
    });
  });

  // A parallel-tool-call turn bundles N tool_result blocks into ONE message
  // (utils.ts:653-662). Gemini rejects a request whose functionResponse count
  // does not match its functionCall count, so every block must survive, not
  // just the first - this is the gap the single-call test above cannot catch.
  it('converts ALL tool_result blocks in a parallel-call turn, not just the first', async () => {
    const backend = new GeminiBackend('test-key');
    let capturedRequest: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      models: {
        generateContentStream: async (request: unknown) => {
          capturedRequest = request;
          return (async function* () {
            yield {
              candidates: [{ content: { parts: [{ text: 'ok' }] } }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            };
          })();
        },
      },
    };

    const assistantMessage: IMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'weather' } },
        { type: 'tool_use', id: 'toolu_2', name: 'get_time', input: {} },
      ],
    } as IMessage;
    const toolResultMessage: IMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny', is_error: false },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: '10:00', is_error: false },
      ],
    } as IMessage;

    await backend.complete(
      'gemini-2.5-flash' as never,
      [assistantMessage, toolResultMessage, { role: 'user', content: 'and tomorrow?' }],
      { stream: true },
      async () => {}
    );

    const contents = capturedRequest.contents;
    const toolResultContent = contents.find((c: any) => c.parts?.[0]?.functionResponse);
    expect(toolResultContent.parts).toHaveLength(2);
    expect(toolResultContent.parts[0].functionResponse).toMatchObject({
      name: 'web_search',
      response: { result: 'sunny' },
    });
    expect(toolResultContent.parts[1].functionResponse).toMatchObject({
      name: 'get_time',
      response: { result: '10:00' },
    });
  });

  // A cross-provider fallback hop (getLlmWithFallback's preferUntriedBackend) can land on
  // Gemini with history fetched for a DIFFERENT primary model - fetchAndProcessPreviousMessages'
  // disableToolReplay carve-out is fixed before that hop happens, so it cannot help here. The
  // guard has to live in the formatter itself, checked against the model this backend is ACTUALLY
  // completing against (gemini-3), not the one history was originally built for.
  it('drops a replayed tool_use/tool_result pair with no thought_signature on a gemini-3 model', async () => {
    const backend = new GeminiBackend('test-key');
    let capturedRequest: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      models: {
        generateContentStream: async (request: unknown) => {
          capturedRequest = request;
          return (async function* () {
            yield {
              candidates: [{ content: { parts: [{ text: 'ok' }] } }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            };
          })();
        },
      },
    };

    const assistantMessage: IMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reply 1' },
        { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'weather' } },
      ],
    } as IMessage;
    const toolResultMessage: IMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny', is_error: false }],
    } as IMessage;

    await backend.complete(
      'gemini-3-pro-preview' as never,
      [assistantMessage, toolResultMessage, { role: 'user', content: 'and tomorrow?' }],
      { stream: true },
      async () => {}
    );

    const contents = capturedRequest.contents;
    const hasFunctionCall = contents.some((c: any) => c.parts?.some((p: any) => p.functionCall));
    const hasFunctionResponse = contents.some((c: any) => c.parts?.some((p: any) => p.functionResponse));
    expect(hasFunctionCall).toBe(false);
    expect(hasFunctionResponse).toBe(false);
    // The text half of the assistant message survives even though the tool call was dropped.
    const assistantContent = contents.find((c: any) => c.role === 'model');
    expect(assistantContent.parts).toEqual([{ text: 'reply 1' }]);
  });

  // Positive control: the same missing-signature shape on a non-gemini-3 model is unaffected -
  // this repo has only observed the rejection on gemini-3, so an older model shouldn't lose a
  // legitimate tool call just because the guard fired too broadly.
  it('still replays a tool_use/tool_result pair with no thought_signature on a non-gemini-3 model', async () => {
    const backend = new GeminiBackend('test-key');
    let capturedRequest: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      models: {
        generateContentStream: async (request: unknown) => {
          capturedRequest = request;
          return (async function* () {
            yield {
              candidates: [{ content: { parts: [{ text: 'ok' }] } }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            };
          })();
        },
      },
    };

    const assistantMessage: IMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reply 1' },
        { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'weather' } },
      ],
    } as IMessage;
    const toolResultMessage: IMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny', is_error: false }],
    } as IMessage;

    await backend.complete(
      'gemini-2.5-flash' as never,
      [assistantMessage, toolResultMessage, { role: 'user', content: 'and tomorrow?' }],
      { stream: true },
      async () => {}
    );

    const contents = capturedRequest.contents;
    const assistantContent = contents.find((c: any) => c.role === 'model');
    expect(assistantContent.parts.some((p: any) => p.functionCall?.name === 'web_search')).toBe(true);
  });

  // The formatter runs on every recursive round of a LIVE tool-calling turn too, and a live
  // round's own just-minted tool_use block can legitimately lack a thought_signature (Gemini
  // omits one on some responses - see the "Missing thought_signature" warn). That is a different
  // failure mode than a replayed block (guaranteed missing, degrade gracefully); a live one
  // should reach Gemini as-is so its existing visible-rejection/retry path still applies, not be
  // silently dropped by the gemini-3 replay guard.
  it('does not drop a gemini-3 live tool_use block minted this same completion, even with no thought_signature', async () => {
    const backend = new GeminiBackend('test-key');
    const capturedRequests: any[] = [];
    let call = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _api: any })._api = {
      models: {
        generateContentStream: async (request: unknown) => {
          capturedRequests.push(request);
          const thisCall = call++;
          return (async function* () {
            if (thisCall === 0) {
              // Round 1: a live functionCall with no thoughtSignature - an observed, legitimate case.
              yield {
                candidates: [
                  { content: { parts: [{ functionCall: { name: 'web_search', args: { query: 'weather' } } }] } },
                ],
                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
              };
            } else {
              yield {
                candidates: [{ content: { parts: [{ text: 'final answer' }] } }],
                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
              };
            }
          })();
        },
      },
    };

    await backend.complete(
      'gemini-3-pro-preview' as never,
      [{ role: 'user', content: 'what is the weather?' }],
      {
        stream: true,
        tools: [
          {
            toolSchema: {
              name: 'web_search',
              description: 'Search the web',
              parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            },
            toolFn: async () => 'sunny',
          },
        ],
      },
      async () => {}
    );

    // Round 2's request is the one that would silently drop round 1's live tool_use/tool_result
    // if the replay guard did not exempt it.
    const round2Contents = capturedRequests[1].contents;
    const hasFunctionCall = round2Contents.some((c: any) => c.parts?.some((p: any) => p.functionCall));
    const hasFunctionResponse = round2Contents.some((c: any) => c.parts?.some((p: any) => p.functionResponse));
    expect(hasFunctionCall).toBe(true);
    expect(hasFunctionResponse).toBe(true);
  });
});
