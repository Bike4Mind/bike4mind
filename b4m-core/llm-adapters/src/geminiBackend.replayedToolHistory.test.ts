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
});
