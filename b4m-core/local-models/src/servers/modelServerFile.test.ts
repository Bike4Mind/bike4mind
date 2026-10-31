import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  credentialHeaders,
  desktopUserDataDirs,
  hydrate,
  isStored,
  localModelId,
  parseLocalModelId,
  readDesktopModelServers,
  serverManagement,
  serverRuntimeId,
} from './modelServerFile';

const SECRET = 'c2VjcmV0LWNpcGhlcnRleHQ=';

function stored(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1b2c3d4e5f6',
    name: 'gpu-box',
    kind: 'ollama',
    transport: { type: 'http', baseUrl: 'http://10.0.0.5:11434' },
    access: 'manage',
    auth: { type: 'bearer' },
    secret: SECRET,
    models: ['qwen3:8b'],
    addedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

describe('desktopUserDataDirs', () => {
  it('uses the override alone when set', () => {
    expect(desktopUserDataDirs({ platform: 'linux', env: { B4M_DESKTOP_USER_DATA: '/x/y' }, home: '/h' })).toEqual([
      '/x/y',
    ]);
  });

  it('ignores a blank override', () => {
    expect(desktopUserDataDirs({ platform: 'linux', env: { B4M_DESKTOP_USER_DATA: '  ' }, home: '/h' })[0]).toBe(
      '/h/.config/@bike4mind/desktop'
    );
  });

  it('finds linux folders under XDG_CONFIG_HOME or ~/.config', () => {
    expect(desktopUserDataDirs({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home: '/h' })).toEqual([
      '/xdg/@bike4mind/desktop',
      '/xdg/Bike4Mind',
    ]);
    expect(desktopUserDataDirs({ platform: 'linux', env: {}, home: '/h' })).toEqual([
      '/h/.config/@bike4mind/desktop',
      '/h/.config/Bike4Mind',
    ]);
  });

  it('finds macOS folders under Application Support', () => {
    expect(desktopUserDataDirs({ platform: 'darwin', env: {}, home: '/Users/m' })).toEqual([
      '/Users/m/Library/Application Support/@bike4mind/desktop',
      '/Users/m/Library/Application Support/Bike4Mind',
    ]);
  });

  it('finds Windows folders under APPDATA or the profile', () => {
    expect(desktopUserDataDirs({ platform: 'win32', env: { APPDATA: 'C:\\A' }, home: 'C:\\Users\\m' })).toEqual([
      'C:\\A\\@bike4mind\\desktop',
      'C:\\A\\Bike4Mind',
    ]);
    expect(desktopUserDataDirs({ platform: 'win32', env: {}, home: 'C:\\Users\\m' })[1]).toBe(
      'C:\\Users\\m\\AppData\\Roaming\\Bike4Mind'
    );
  });
});

describe('readDesktopModelServers', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'b4m-servers-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const opts = (env: Record<string, string> = {}) => ({ platform: 'linux' as const, env, home: root });

  async function put(folder: string, body: string): Promise<string> {
    const dir = path.join(root, '.config', folder);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'model-servers.json');
    await writeFile(file, body);
    return file;
  }

  it('reads the packaged folder and drops the secret', async () => {
    const file = await put('@bike4mind/desktop', JSON.stringify({ version: 1, servers: [stored()] }));
    const result = await readDesktopModelServers(opts());
    expect(result.path).toBe(file);
    expect(result.problem).toBeNull();
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({ id: 'a1b2c3d4e5f6', name: 'gpu-box', auth: { type: 'bearer' } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.servers[0]).not.toHaveProperty('secret');
  });

  it('falls back to the product-name folder', async () => {
    await put('Bike4Mind', JSON.stringify({ version: 1, servers: [stored({ name: 'second' })] }));
    expect((await readDesktopModelServers(opts())).servers.map(s => s.name)).toEqual(['second']);
  });

  it('prefers the first folder that has the file', async () => {
    await put('@bike4mind/desktop', JSON.stringify({ servers: [stored({ name: 'first' })] }));
    await put('Bike4Mind', JSON.stringify({ servers: [stored({ name: 'second' })] }));
    expect((await readDesktopModelServers(opts())).servers.map(s => s.name)).toEqual(['first']);
  });

  it('honors B4M_DESKTOP_USER_DATA', async () => {
    const dir = path.join(root, 'custom');
    await mkdir(dir);
    await writeFile(path.join(dir, 'model-servers.json'), JSON.stringify({ servers: [stored()] }));
    await put('@bike4mind/desktop', JSON.stringify({ servers: [stored({ name: 'ignored' })] }));
    const result = await readDesktopModelServers(opts({ B4M_DESKTOP_USER_DATA: dir }));
    expect(result.servers.map(s => s.name)).toEqual(['gpu-box']);
  });

  it('returns nothing cleanly when Desktop is not installed', async () => {
    expect(await readDesktopModelServers(opts())).toEqual({ servers: [], path: null, problem: null });
  });

  it('reports malformed JSON without quoting it', async () => {
    const file = await put('@bike4mind/desktop', `{"servers": [ {"secret": "${SECRET}" oops`);
    const result = await readDesktopModelServers(opts());
    expect(result).toMatchObject({ servers: [], path: file });
    expect(result.problem).toBeTruthy();
    expect(result.problem).not.toContain(SECRET);
  });

  it('reports a file it cannot read without quoting it', async () => {
    const dir = path.join(root, '.config', '@bike4mind/desktop', 'model-servers.json');
    await mkdir(dir, { recursive: true });
    const result = await readDesktopModelServers(opts());
    expect(result).toMatchObject({ servers: [], path: dir });
    expect(result.problem).toMatch(/could not be read \(EISDIR\)/);
  });

  it('reports a file with no server list', async () => {
    await put('@bike4mind/desktop', JSON.stringify({ version: 1 }));
    const result = await readDesktopModelServers(opts());
    expect(result.servers).toEqual([]);
    expect(result.problem).toBeTruthy();
  });

  it('skips records it cannot use, such as an ssh transport', async () => {
    const body = {
      servers: [
        stored({ id: 'ssh1', transport: { type: 'ssh', host: 'box' } }),
        stored({ id: 'bad', kind: 'other' }),
        'junk',
        stored({ id: 'ok1', name: 'kept' }),
      ],
    };
    await put('@bike4mind/desktop', JSON.stringify(body));
    expect((await readDesktopModelServers(opts())).servers.map(s => s.name)).toEqual(['kept']);
  });

  it('reads a newer version as it is and never writes the file', async () => {
    const body = JSON.stringify({ version: 2, servers: [stored({ extra: { a: 1 } })] });
    const file = await put('@bike4mind/desktop', body);
    const result = await readDesktopModelServers(opts());
    expect(result.servers).toHaveLength(1);
    expect(await readFile(file, 'utf8')).toBe(body);
  });

  it('removes credentials embedded in an address', async () => {
    await put(
      '@bike4mind/desktop',
      JSON.stringify({
        servers: [stored({ transport: { type: 'http', baseUrl: 'http://user:pw-zz@10.0.0.5:11434' } })],
      })
    );
    const result = await readDesktopModelServers(opts());
    expect(JSON.stringify(result)).not.toContain('pw-zz');
    expect(result.servers[0].transport.baseUrl).toBe('http://10.0.0.5:11434');
  });
});

describe('stored records', () => {
  it('checks and hydrates a record without its secret', () => {
    const record = stored();
    expect(isStored(record)).toBe(true);
    expect(hydrate(record as never)).not.toHaveProperty('secret');
    expect(isStored({ ...record, id: 'UPPER' })).toBe(false);
  });

  it('keeps only specs that check out', () => {
    const good = { ramGiB: 32, gpuMemoryGiB: null, bandwidthGBps: null, unified: false };
    expect(hydrate(stored({ specs: good }) as never)?.specs).toEqual(good);
    expect(hydrate(stored({ specs: { ...good, ramGiB: -1 } }) as never)?.specs).toBeNull();
  });
});

describe('credentialHeaders', () => {
  it('builds bearer and header credentials and refuses reserved names', () => {
    expect(credentialHeaders({ type: 'none' })).toBeNull();
    expect(credentialHeaders({ type: 'bearer', token: ' tok ' })).toEqual({ authorization: 'Bearer tok' });
    expect(credentialHeaders({ type: 'header', name: 'X-Key', value: 'v' })).toEqual({ 'x-key': 'v' });
    expect(() => credentialHeaders({ type: 'header', name: 'Cookie', value: 'v' })).toThrow(/cannot carry/);
  });
});

describe('shared ids', () => {
  it('round-trips namespaced model ids', () => {
    const id = localModelId(serverRuntimeId('a1b2'), 'org/model:q4');
    expect(id).toBe('local:srv-a1b2:org/model:q4');
    expect(parseLocalModelId(id)).toEqual({ runtimeId: 'srv-a1b2', model: 'org/model:q4' });
    expect(parseLocalModelId('local:%E0%A4%A:x')).toBeNull();
  });

  it('says what a server allows', () => {
    expect(serverManagement({ kind: 'ollama', access: 'manage' })).toBe('allowed');
    expect(serverManagement({ kind: 'ollama', access: 'chat' })).toBe('chat-only');
    expect(serverManagement({ kind: 'openai-compatible', access: 'manage' })).toBe('unsupported');
    expect(serverManagement({ local: true, kind: 'openai-compatible', access: 'chat' })).toBe('allowed');
  });
});
