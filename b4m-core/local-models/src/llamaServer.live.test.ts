import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIN_LLAMA_SERVER_BUILD, findLlamaServer } from './llamaServer';
import { LlamaServerRuntime } from './llamaServerRuntime';

// Opt-in check against a real llama-server binary and a small GGUF file; the package README has the command.
const BINARY = process.env.LOCAL_MODELS_LIVE_LLAMA_SERVER;
const GGUF = process.env.LOCAL_MODELS_LIVE_LLAMA_SERVER_GGUF;

describe.runIf(BINARY && GGUF)('live llama-server', () => {
  let dir: string;
  let runtime: LlamaServerRuntime;
  const model = basename(GGUF ?? '');
  const lines: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'llama-server-live-'));
    runtime = new LlamaServerRuntime({
      binaryPath: BINARY as string,
      modelsDir: dir,
      contextSize: 2048,
      onLog: (_, line) => lines.push(line),
    });
    await runtime.store.add(GGUF as string);
  }, 120_000);

  afterAll(async () => {
    await runtime?.stopAll();
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts the binary as new enough', async () => {
    const found = await findLlamaServer({ path: BINARY });
    expect(found?.build).toBeGreaterThanOrEqual(MIN_LLAMA_SERVER_BUILD);
    expect(await runtime.health()).toMatchObject({ ok: true, version: found?.version });
  });

  it('serves the model on loopback behind its key and answers a chat request', async () => {
    const server = await runtime.start(model);
    expect(await runtime.loaded()).toEqual([expect.objectContaining({ name: model, contextLength: 2048 })]);
    // b5501 answers /v1/models without a key; /props needs it in every supported build.
    expect((await fetch(`${server.baseUrl}/props`)).status).toBe(401);
    const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: server.model,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content.length).toBeGreaterThan(0);
    await runtime.stop(model);
    expect(server.running).toBe(false);
  }, 120_000);

  it('cancels a start once the process is up but not yet ready', async () => {
    lines.length = 0;
    const pending = runtime.start(model).catch((caught: unknown) => caught);
    while (lines.length === 0) await new Promise(done => setTimeout(done, 5));
    await runtime.stop(model);
    expect(await pending).toMatchObject({ message: `${model} was stopped before it was ready` });
    expect(await runtime.running()).toEqual([]);
  }, 60_000);

  it.skipIf(process.platform === 'win32')(
    'stops a server behind a launcher that drops its key',
    async () => {
      const launched = new LlamaServerRuntime({
        binaryPath: '/usr/bin/env',
        binaryArgs: ['-u', 'LLAMA_API_KEY', BINARY as string],
        // A launcher's own directory says nothing about the libraries of the binary it runs.
        env: { ...process.env, LD_LIBRARY_PATH: dirname(BINARY as string) },
        modelsDir: dir,
        contextSize: 2048,
      });
      const error = await launched.start(model).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: 'LlamaServerStartError', reason: 'unauthenticated' });
      expect(await launched.running()).toEqual([]);
    },
    120_000
  );
});
