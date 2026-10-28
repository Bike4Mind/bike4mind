import { afterEach, describe, expect, it } from 'vitest';
import { OllamaRuntime, type HardwareProfile, type PullProgress } from '@bike4mind/local-models';
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
async function resumableOllama(): Promise<FakeServer> {
  let stored = 0;
  let requests = 0;
  return startFakeServer({
    'POST /api/pull': async (_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(ndjson([{ status: 'pulling manifest' }, layerFrame(stored)]));
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
  it('resumes the partial download, and says so', async () => {
    server = await resumableOllama();
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
          if (pulls.length === 1 && update.completedBytes >= 400) controller.abort();
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
    expect(pulls[0].find(frame => frame.totalBytes)?.completedBytes).toBe(0);

    controller = new AbortController();
    const second = await run();
    expect(second.code).toBe(0);
    const resumedFrom = pulls[1].find(frame => frame.totalBytes)?.completedBytes ?? 0;
    expect(resumedFrom).toBeGreaterThan(0);
    expect(second.lines).toContain(`Already downloaded: ${resumedFrom} B; pulling the rest.`);
    expect(first.lines.some(line => line.startsWith('Already downloaded'))).toBe(false);
  });
});
