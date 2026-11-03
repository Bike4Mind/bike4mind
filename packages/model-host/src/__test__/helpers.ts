import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostFacts, OllamaSettings } from '@bike4mind/common/modelHub';
import type { ModelHostProbe } from '@bike4mind/local-models';

export const facts: HostFacts = {
  os: { name: 'Ubuntu 24.04.3 LTS', kernel: '6.8.0-90-generic' },
  cpu: { model: 'AMD Ryzen 7 5800X', cores: 8, threads: 16 },
  memory: { totalBytes: 68719476736, availableBytes: 51200000000 },
  gpus: [],
  hardware: {
    platform: 'linux',
    arch: 'x64',
    memoryKind: 'cpu',
    totalMemoryBytes: 68719476736,
    gpuMemoryBytes: null,
    gpuName: null,
    gpuCount: 0,
    chip: null,
    diskFreeBytes: 1024000000000,
    confidence: 'high',
  },
  ollama: {
    url: 'http://127.0.0.1:11434',
    reachable: true,
    version: '0.40.11',
    install: { type: 'manual', unit: null, binary: '/usr/local/bin/ollama' },
    store: {
      path: '/srv/models',
      source: 'process-home',
      mountPoint: '/',
      freeBytes: 1024000000000,
      confidence: 'high',
    },
    loaded: [],
  },
  fitRuntime: { kind: 'ollama', slots: 1, flashAttn: 'auto' },
  fitRuntimeConfidence: 'high',
  defaultContext: 4096,
};

export const settings: OllamaSettings = {
  readable: true,
  settings: [{ key: 'OLLAMA_NUM_PARALLEL', value: '1', source: { kind: 'default', path: null }, writable: true }],
  unreadablePaths: [],
};

export const probe = (): Promise<ModelHostProbe> => Promise.resolve({ host: facts, settings });

/** Unix sockets need a short path, so these live under the system temp dir rather than a long scratch path. */
export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'b4mh-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export function get(socketPath: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, headers, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Writes raw bytes, half-closes, and collects everything until the server closes; a reset just ends it. */
export function raw(socketPath: string, ...parts: Array<string | Buffer>): Promise<string> {
  return new Promise(resolve => {
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => (text += chunk));
    socket.on('error', () => {});
    socket.on('close', () => resolve(text));
    socket.on('connect', async () => {
      for (const part of parts) {
        socket.write(part);
        await new Promise(r => setTimeout(r, 20));
      }
      socket.end();
    });
  });
}
