import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { GeminiBackend } from './geminiBackend';

const MODEL = ChatModels.GEMINI_2_5_FLASH_LITE;
const fetchFailed = () =>
  new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) });
const textChunk = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
});

function backendWith(models: Record<string, unknown>) {
  const backend = new GeminiBackend('test-key');
  (backend as unknown as { _api: unknown })._api = { models };
  return backend;
}

afterEach(() => vi.useRealTimers());

describe('GeminiBackend transport retry', () => {
  it('retries a failed stream open and delivers the text once', async () => {
    const generateContentStream = vi
      .fn()
      .mockRejectedValueOnce(fetchFailed())
      .mockImplementation(async () =>
        (async function* () {
          yield textChunk('hello');
        })()
      );
    const emitted: unknown[] = [];

    await backendWith({ generateContentStream }).complete(
      MODEL,
      [{ role: 'user', content: 'hi' }],
      { stream: true },
      async results => {
        emitted.push(...results);
      }
    );

    expect(generateContentStream).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual(['hello']);
  });

  it('retries a failed non-streaming request', async () => {
    const generateContent = vi.fn().mockRejectedValueOnce(fetchFailed()).mockResolvedValue(textChunk('hello'));

    await backendWith({ generateContent }).complete(
      MODEL,
      [{ role: 'user', content: 'hi' }],
      { stream: false },
      async () => {}
    );

    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failure after the stream started yielding', async () => {
    const generateContentStream = vi.fn().mockImplementation(async () =>
      (async function* () {
        yield textChunk('partial');
        throw fetchFailed();
      })()
    );

    await expect(
      backendWith({ generateContentStream }).complete(
        MODEL,
        [{ role: 'user', content: 'hi' }],
        { stream: true },
        async () => {}
      )
    ).rejects.toThrow('fetch failed');
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });
});
