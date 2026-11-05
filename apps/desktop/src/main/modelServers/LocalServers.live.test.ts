import { spawn } from 'node:child_process';
import { findOllamaBinary } from '@bike4mind/local-models';
import { describe, expect, it } from 'vitest';
import type { SecretCipher, StoreFile } from '../chat/mcp/McpServerStore';
import { hostLaunchers } from './LocalServerSupervisor';
import { ModelServerRegistry } from './ModelServerRegistry';
import { ModelServerStore } from './ModelServerStore';
import { readHostOllamaEnv } from './observedOllama';

// Opt-in check that starts real servers on spare loopback ports: `ollama serve` from PATH (set OLLAMA_MODELS to a
// scratch folder) and a llama-server router over DESKTOP_LIVE_GGUF_DIR. Linux only, for the settings read.
const ON = process.env.DESKTOP_LIVE_MANAGED_SERVERS === 'on' && process.platform === 'linux';
const OLLAMA_PORT = Number(process.env.DESKTOP_LIVE_OLLAMA_PORT ?? 11500);
const ROUTER_PORT = Number(process.env.DESKTOP_LIVE_ROUTER_PORT ?? 8090);
const LLAMA_SERVER = process.env.DESKTOP_LIVE_LLAMA_SERVER;
const GGUF_DIR = process.env.DESKTOP_LIVE_GGUF_DIR;

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: plain => Buffer.from(plain, 'utf8'),
  decryptString: encrypted => encrypted.toString('utf8'),
};

function memoryFile(): StoreFile {
  let contents: string | null = null;
  return {
    read: async () => contents,
    write: async next => {
      contents = next;
    },
  };
}

const quiet = { debug: () => undefined, warn: () => undefined };
const none = { type: 'none' as const };

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

describe.runIf(ON)('live servers Desktop starts', () => {
  const registry = new ModelServerRegistry({
    store: new ModelServerStore(cipher, memoryFile(), quiet),
    logger: quiet,
    readOllamaEnv: url => readHostOllamaEnv(url),
    launchers: hostLaunchers(),
  });
  const ollamaUrl = `http://127.0.0.1:${OLLAMA_PORT}`;

  it('leaves an Ollama it did not start alone, shows its settings, then starts its own with the saved ones', async () => {
    expect(await answers(`${ollamaUrl}/api/version`)).toBe(false);
    const binary = await findOllamaBinary({ path: process.env.PATH ?? '' });
    if (!binary) throw new Error('ollama is not on PATH');
    const outside = spawn(binary, ['serve'], {
      env: {
        ...process.env,
        OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
        OLLAMA_KV_CACHE_TYPE: 'q4_0',
        OLLAMA_FLASH_ATTENTION: '1',
      },
      stdio: 'ignore',
    });
    try {
      await until(() => answers(`${ollamaUrl}/api/version`));
      const [, added] = await registry.add({
        address: ollamaUrl,
        credential: none,
        name: 'spare ollama',
        kind: 'ollama',
        access: 'chat',
      });
      expect(added.launch).toMatchObject({
        owner: 'other',
        canStart: false,
        observed: { OLLAMA_KV_CACHE_TYPE: 'q4_0', OLLAMA_FLASH_ATTENTION: '1' },
        sizingKvCacheType: 'q4_0',
      });
      await expect(registry.update(added.id, { launch: { kvCacheType: 'q8_0' } })).rejects.toThrow(
        'was not started by Bike4Mind Desktop'
      );
      await expect(registry.startServer(added.id)).rejects.toThrow('Something already answers');
    } finally {
      outside.kill('SIGTERM');
    }
    await until(async () => !(await answers(`${ollamaUrl}/api/version`)));

    const id = (await registry.views())[1].id;
    await registry.check(id);
    await registry.update(id, { launch: { kvCacheType: 'q8_0' } });
    const [, running] = await registry.startServer(id);
    expect(running.health.state).toBe('online');
    expect(running.launch).toMatchObject({ owner: 'desktop', sizingKvCacheType: 'q8_0', pendingRestart: false });
    expect(await readHostOllamaEnv(ollamaUrl)).toMatchObject({
      OLLAMA_KV_CACHE_TYPE: 'q8_0',
      OLLAMA_FLASH_ATTENTION: '1',
      OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`,
    });

    await registry.update(id, { launch: { kvCacheType: 'q4_0' } });
    expect((await registry.views())[1].launch?.pendingRestart).toBe(true);
    const [, restarted] = await registry.restartServer(id);
    expect(restarted.launch).toMatchObject({ owner: 'desktop', pendingRestart: false, sizingKvCacheType: 'q4_0' });
    expect((await readHostOllamaEnv(ollamaUrl))?.OLLAMA_KV_CACHE_TYPE).toBe('q4_0');

    const [, stopped] = await registry.stopServer(id);
    expect(stopped.launch).toMatchObject({ owner: 'none', canStart: true });
    expect(await answers(`${ollamaUrl}/api/version`)).toBe(false);
  }, 120_000);

  it.runIf(LLAMA_SERVER && GGUF_DIR)(
    'runs a keyed llama-server router over a models folder and stops it on quit',
    async () => {
      const routerUrl = `http://127.0.0.1:${ROUTER_PORT}`;
      expect(await answers(`${routerUrl}/health`)).toBe(false);
      const [, , added] = await registry.add({
        address: routerUrl,
        credential: none,
        name: 'spare router',
        kind: 'openai-compatible',
        access: 'chat',
        launch: true,
      });
      expect(added.launch).toMatchObject({ runtime: 'llama-server', owner: 'none', canStart: true });
      await registry.update(added.id, { launch: { binaryPath: LLAMA_SERVER, modelsDir: GGUF_DIR } });
      const [, , running] = await registry.startServer(added.id);
      expect(running.health.state).toBe('online');
      expect(running.launch).toMatchObject({ owner: 'desktop', noun: 'llama-server' });
      const listed = await registry.hubServer(added.id)!.runtime.list();
      expect(listed.length).toBeGreaterThan(0);
      expect((await fetch(`${routerUrl}/v1/models`)).status).toBe(401);

      await registry.stopLocalServers();
      expect(await answers(`${routerUrl}/health`)).toBe(false);
    },
    120_000
  );
});
