import { afterEach, describe, expect, it } from 'vitest';
import { json, startFakeServer, type FakeServer } from './__test__/fakeServer';
import { ollamaLibraryLayers } from './ollamaRegistry';

const model = 'e'.repeat(64);
const template = 'b'.repeat(64);

let server: FakeServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('ollamaLibraryLayers', () => {
  it('reads the model digest and every other layer of a library tag', async () => {
    server = await startFakeServer({
      'GET /v2/library/gemma4/manifests/e4b-it-qat': json({
        schemaVersion: 2,
        layers: [
          { mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${model}`, size: 5 },
          { mediaType: 'application/vnd.ollama.image.template', digest: `sha256:${template}`, size: 13 },
        ],
      }),
    });
    expect(await ollamaLibraryLayers('gemma4:e4b-it-qat', { endpoint: server.baseUrl })).toEqual({
      model,
      others: [{ mediaType: 'application/vnd.ollama.image.template', digest: template }],
    });
    expect(server.requests[0]?.headers.accept).toBe('application/vnd.docker.distribution.manifest.v2+json');
  });

  it('returns null for a tag the registry does not have', async () => {
    server = await startFakeServer({});
    expect(await ollamaLibraryLayers('qwen3.5:404b', { endpoint: server.baseUrl })).toBeNull();
  });

  it('gives no model digest when a manifest has more than one weights layer', async () => {
    server = await startFakeServer({
      'GET /v2/library/qwen3.5/manifests/4b': json({
        layers: [
          { mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${model}` },
          { mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${template}` },
        ],
      }),
    });
    expect((await ollamaLibraryLayers('qwen3.5:4b', { endpoint: server.baseUrl }))?.model).toBeNull();
  });

  it.each(['hf.co/a/b:Q4', 'gemma4', '../x:1', 'Gemma4:e4b'])('rejects %s, which is not a library ref', async ref => {
    await expect(ollamaLibraryLayers(ref, { endpoint: 'http://127.0.0.1:1' })).rejects.toThrow(
      'Invalid Ollama library ref'
    );
  });

  it('surfaces a server error', async () => {
    server = await startFakeServer({ 'GET /v2/library/gemma4/manifests/12b-it-qat': json({ error: 'down' }, 503) });
    await expect(ollamaLibraryLayers('gemma4:12b-it-qat', { endpoint: server.baseUrl })).rejects.toThrow('HTTP 503');
  });
});
