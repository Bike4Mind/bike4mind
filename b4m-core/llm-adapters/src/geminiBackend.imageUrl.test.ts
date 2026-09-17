import { describe, it, expect } from 'vitest';
import { GeminiBackend } from './geminiBackend';
import type { IMessage } from '@bike4mind/common';

/**
 * normalizeMultimodalMessages canonicalizes every inbound image dialect to `image_url`
 * (including an Anthropic url-source image, which this backend previously matched as
 * `type: 'image'` and mishandled). Without a reader for the canonical shape, a message
 * matching none of formatMessagesIntoGeminiContent's branches is dropped by its trailing
 * `.filter(part => !!part)` - the whole user turn silently vanishes, not just the image.
 */
describe('GeminiBackend - canonical image_url content', () => {
  function backendWithCapture() {
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
    return { backend, getRequest: () => capturedRequest };
  }

  it('turns a data-URL image_url part into inlineData', async () => {
    const { backend, getRequest } = backendWithCapture();
    const message: IMessage = {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] as never,
    };

    await backend.complete('gemini-2.5-flash' as never, [message], { stream: true }, async () => {});

    const userContent = getRequest().contents.find((c: any) => c.role === 'user');
    expect(userContent).toBeDefined();
    expect(userContent.parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }]);
  });

  it('turns an http(s) image_url part into fileData instead of silently dropping the turn', async () => {
    const { backend, getRequest } = backendWithCapture();
    const message: IMessage = {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] as never,
    };

    await backend.complete('gemini-2.5-flash' as never, [message], { stream: true }, async () => {});

    const userContent = getRequest().contents.find((c: any) => c.role === 'user');
    expect(userContent).toBeDefined();
    expect(userContent.parts).toEqual([{ fileData: { fileUri: 'https://x.test/a.png' } }]);
  });
});
