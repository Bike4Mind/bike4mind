import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDesktopModelServers } from '@bike4mind/local-models/servers';
import {
  findModelServer,
  loadModelServers,
  needsCredential,
  serverCredential,
  validateSecret,
  type CliModelServer,
} from './modelServers';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-model-servers-'));
  process.env.B4M_DESKTOP_USER_DATA = dir;
});

afterEach(async () => {
  delete process.env.B4M_DESKTOP_USER_DATA;
  await rm(dir, { recursive: true, force: true });
});

const stored = (over: Record<string, unknown>) => ({
  id: 'a1b2c3',
  name: 'gpu-box',
  kind: 'ollama',
  transport: { type: 'http', baseUrl: 'http://10.0.0.5:11434' },
  access: 'manage',
  auth: { type: 'bearer' },
  secret: 'ZGVza3RvcC1jaXBoZXJ0ZXh0',
  models: [],
  addedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

async function loaded(servers: unknown[]) {
  await writeFile(path.join(dir, 'model-servers.json'), JSON.stringify({ version: 1, servers }));
  return loadModelServers();
}

describe('loadModelServers', () => {
  it("reads Desktop's file through B4M_DESKTOP_USER_DATA and marks each server as Desktop's, without its secret", async () => {
    const { servers, problem } = await loaded([
      stored({}),
      stored({ id: 'd4e5f6', name: 'ssh-box', transport: { type: 'ssh' } }),
    ]);
    expect(problem).toBeNull();
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ id: 'a1b2c3', name: 'gpu-box', source: 'desktop' });
    expect(JSON.stringify(servers)).not.toContain('ZGVza3RvcC1jaXBoZXJ0ZXh0');
  });

  it('uses the injected reader and passes its problem through', async () => {
    const result = await loadModelServers(async () => ({ servers: [], path: null, problem: 'broken' }));
    expect(result).toEqual({ servers: [], problem: 'broken' });
    expect((await readDesktopModelServers()).path).toBeNull();
  });
});

describe('credentials', () => {
  async function one(over: Record<string, unknown> = {}): Promise<CliModelServer> {
    return (await loaded([stored(over)])).servers[0];
  }

  it('joins the CLI secret to the Desktop record by id and builds the header', async () => {
    const server = await one();
    expect(serverCredential(server, 'tok-123')).toEqual({ authorization: 'Bearer tok-123' });
    expect(needsCredential(server, 'tok-123')).toBe(false);
  });

  it('reports "needed" for a record with no CLI credential', async () => {
    const server = await one();
    expect(serverCredential(server, undefined)).toBeNull();
    expect(needsCredential(server, undefined)).toBe(true);
  });

  it('needs nothing for a server without credentials', async () => {
    const server = await one({ auth: { type: 'none' } });
    expect(needsCredential(server, undefined)).toBe(false);
    expect(serverCredential(server, 'ignored')).toBeNull();
  });

  it('sends a named header for header auth', async () => {
    const server = await one({ auth: { type: 'header', name: 'X-Api-Key' } });
    expect(serverCredential(server, 'k-1')).toEqual({ 'x-api-key': 'k-1' });
  });

  it('validates a secret with the shared rules and never echoes it', async () => {
    const server = await one();
    expect(validateSecret(server, '  tok-123  ')).toBe('tok-123');
    expect(() => validateSecret(server, '   ')).toThrow('Enter the token.');
    expect(() => validateSecret(server, 'has space')).toThrow(/control character, a space/);
    try {
      validateSecret(server, 'bad token');
    } catch (error) {
      expect((error as Error).message).not.toContain('bad token');
    }
  });
});

describe('findModelServer', () => {
  it('matches an exact name first, then ignoring case', async () => {
    const { servers } = await loaded([stored({ id: 'a', name: 'GPU' }), stored({ id: 'b', name: 'gpu' })]);
    expect(findModelServer(servers, 'gpu')?.id).toBe('b');
    expect(findModelServer(servers, 'Gpu')?.id).toBe('a');
    expect(findModelServer(servers, 'x')).toBeUndefined();
  });
});
