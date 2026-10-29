import { afterEach, describe, expect, it } from 'vitest';
import { OllamaRuntime, loadCuratedManifest, type HardwareProfile, type PullProgress } from '@bike4mind/local-models';
import { delay, startFakeServer, type FakeServer } from '@bike4mind/local-models/testing';
import { EXIT_CANCELLED, runModelsCommand, type ModelsDeps } from './modelsCommand.js';

const LAYER = `sha256:${'c'.repeat(64)}`;
const TOTAL = 1000;

const CPU_64: HardwareProfile = {
  platform: 'linux',
  arch: 'x64',
  memoryKind: 'cpu',
  totalMemoryBytes: 64 * 1024 ** 3,
  gpuMemoryBytes: null,
  gpuName: null,
  gpuCount: 0,
  chip: null,
  diskFreeBytes: null,
  confidence: 'high',
};

const ndjson = (frames: object[]) => frames.map(frame => `${JSON.stringify(frame)}\n`).join('');
const layerFrame = (completed: number) => ({ status: `pulling ${LAYER}`, digest: LAYER, total: TOTAL, completed });

/** Ollama's /api/pull with the partial blob it keeps between requests: the first stalls at 400 bytes. */
async function resumableOllama(cachedLayer = false): Promise<FakeServer> {
  let stored = 0;
  let requests = 0;
  return startFakeServer({
    'POST /api/pull': async (_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(
        ndjson([
          { status: 'pulling manifest' },
          ...(cachedLayer
            ? [{ status: 'pulling cached', digest: `sha256:${'d'.repeat(64)}`, total: 200, completed: 200 }]
            : []),
          layerFrame(stored),
        ])
      );
      if (requests === 1) {
        for (const completed of [150, 400]) {
          await delay(5);
          stored = completed;
          response.write(ndjson([layerFrame(completed)]));
        }
        return;
      }
      stored = TOTAL;
      response.end(
        ndjson([
          layerFrame(TOTAL),
          { status: 'verifying sha256 digest' },
          { status: 'writing manifest' },
          { status: 'success' },
        ])
      );
    },
  });
}

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('b4m models pull after an interrupted pull', () => {
  it.each([false, true])(
    'resumes the partial download with a cached first layer = %s, and says so',
    async cachedLayer => {
      server = await resumableOllama(cachedLayer);
      const runtime = new OllamaRuntime({ baseUrl: server.baseUrl });
      const realPull = runtime.pull.bind(runtime);
      const pulls: PullProgress[][] = [];
      let controller = new AbortController();
      runtime.pull = (ref, opts = {}) => {
        const frames: PullProgress[] = [];
        pulls.push(frames);
        return realPull(ref, {
          ...opts,
          onProgress: update => {
            frames.push(update);
            opts.onProgress?.(update);
            if (pulls.length === 1 && update.completedBytes >= (cachedLayer ? 600 : 400)) controller.abort();
          },
        });
      };

      const run = async () => {
        const lines: string[] = [];
        const deps: ModelsDeps = {
          hub: () => {
            throw new Error('an Ollama name needs no Hugging Face lookup');
          },
          ollamaRegistry: async () => ({ digest: LAYER, layers: [LAYER], sizeBytes: TOTAL, licenses: [] }),
          resolveRuntime: async () => ({ runtime, source: 'config' }),
          config: { defaultModel: undefined, ollamaHost: server?.baseUrl, save: async () => {} },
          confirm: async () => false,
          isTTY: false,
          log: line => lines.push(line),
          progress: { update: () => {}, end: () => {} },
          machine: async () => ({ hardware: CPU_64 }),
          runtimeHost: () => server?.baseUrl ?? null,
          curated: () => loadCuratedManifest(() => {}),
          hardware: async () => CPU_64,
          signal: controller.signal,
        };
        const code = await runModelsCommand(
          'pull',
          { _: [], ref: 'tiny:latest', yes: true, 'accept-license': true },
          deps
        );
        return { code, lines };
      };

      const first = await run();
      expect(first.code).toBe(EXIT_CANCELLED);
      expect(first.lines[first.lines.length - 1]).toMatch(/^Pull cancelled\. .*pulling again resumes it\.$/);
      expect(pulls[0].find(frame => frame.totalBytes)?.completedBytes).toBe(cachedLayer ? 200 : 0);

      controller = new AbortController();
      const second = await run();
      expect(second.code).toBe(0);
      const resumedFrom =
        pulls[1].find(frame => frame.totalBytes && frame.completedBytes < frame.totalBytes)?.completedBytes ?? 0;
      expect(resumedFrom).toBeGreaterThan(0);
      expect(second.lines).toContain(`Already downloaded: ${resumedFrom} B; pulling the rest.`);
      expect(first.lines.some(line => line.startsWith('Already downloaded'))).toBe(cachedLayer);
    }
  );

  it('says nothing about resuming when the model is already fully downloaded', async () => {
    server = await startFakeServer({
      'POST /api/pull': async (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(ndjson([{ status: 'pulling manifest' }, layerFrame(TOTAL), { status: 'success' }]));
      },
    });
    const runtime = new OllamaRuntime({ baseUrl: server.baseUrl });
    const lines: string[] = [];
    const code = await runModelsCommand(
      'pull',
      { _: [], ref: 'tiny:latest', yes: true, 'accept-license': true },
      {
        hub: () => {
          throw new Error('an Ollama name needs no Hugging Face lookup');
        },
        ollamaRegistry: async () => ({ digest: LAYER, layers: [LAYER], sizeBytes: TOTAL, licenses: [] }),
        resolveRuntime: async () => ({ runtime, source: 'config' }),
        config: { defaultModel: undefined, ollamaHost: server.baseUrl, save: async () => {} },
        confirm: async () => false,
        isTTY: false,
        log: line => lines.push(line),
        progress: { update: () => {}, end: () => {} },
        machine: async () => ({ hardware: CPU_64 }),
        runtimeHost: () => server?.baseUrl ?? null,
        curated: () => loadCuratedManifest(() => {}),
        hardware: async () => CPU_64,
        signal: new AbortController().signal,
      }
    );
    expect(code).toBe(0);
    expect(lines.some(line => line.startsWith('Pulled tiny:latest.'))).toBe(true);
    expect(lines.some(line => line.startsWith('Already downloaded'))).toBe(false);
  });
});
