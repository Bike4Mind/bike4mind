import { describe, it, expect } from 'vitest';
import { ModelBackend, type IMessage, type ModelInfo } from '@bike4mind/common';
import { GeminiBackend } from './geminiBackend';

const CATALOG_ONLY_ID = 'gemini-99-flash';

function backendWithCapture() {
  const backend = new GeminiBackend('test-key');
  const requests: Array<{ model: string }> = [];
  (backend as unknown as { _api: unknown })._api = {
    models: {
      generateContentStream: async (request: { model: string }) => {
        requests.push(request);
        return (async function* () {
          yield {
            candidates: [{ content: { parts: [{ text: 'ok' }] } }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
          };
        })();
      },
    },
  };
  return { backend, requests };
}

const message: IMessage = { role: 'user', content: 'hi' };

describe('GeminiBackend - catalog-only model ids', () => {
  it('completes an id that only the catalog record describes', async () => {
    const { backend, requests } = backendWithCapture();
    backend.setDispatchModel({
      id: CATALOG_ONLY_ID,
      name: 'Gemini 99 Flash',
      backend: ModelBackend.Gemini,
      type: 'text',
      contextWindow: 1_000_000,
    } as unknown as ModelInfo);

    const chunks: string[] = [];
    await backend.complete(CATALOG_ONLY_ID as never, [message], { stream: true }, async text => {
      chunks.push(...text.filter((t): t is string => typeof t === 'string'));
    });

    expect(requests[0]?.model).toBe(CATALOG_ONLY_ID);
    expect(chunks.join('')).toContain('ok');
  });

  it('still rejects an id neither the literal list nor the dispatch record knows', async () => {
    const { backend } = backendWithCapture();
    await expect(
      backend.complete(CATALOG_ONLY_ID as never, [message], { stream: true }, async () => {})
    ).rejects.toThrow(`Model ${CATALOG_ONLY_ID} not found`);
  });
});
