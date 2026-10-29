import { describe, expect, it, vi } from 'vitest';
import type { SecretCipher, StoreFile } from '../chat/mcp/McpServerStore';
import { credentialHeaders, MAX_MODEL_SERVERS, ModelServerStore } from './ModelServerStore';

const TOKEN = 'tok-secret-zz';
const HEADER_VALUE = 'hdr-secret-qq';

function cipher(available = true): SecretCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: plain => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: encrypted => encrypted.toString('utf8').replace(/^enc:/, ''),
  };
}

function memoryFile(contents: string | null = null): StoreFile & { contents: string | null } {
  return {
    contents,
    read() {
      return Promise.resolve(this.contents);
    },
    write(next: string) {
      this.contents = next;
      return Promise.resolve();
    },
  };
}

const logger = { debug: vi.fn(), warn: vi.fn() };
const base = {
  name: 'gpu box',
  kind: 'ollama' as const,
  transport: { type: 'http' as const, baseUrl: 'https://gpu.example.test' },
  access: 'chat' as const,
};

describe('ModelServerStore', () => {
  it('keeps a bearer token only as ciphertext on disk and reads it back after a restart', async () => {
    const file = memoryFile();
    const record = await new ModelServerStore(cipher(), file, logger).add(base, { type: 'bearer', token: TOKEN });
    expect(file.contents).not.toContain(TOKEN);
    expect(JSON.parse(file.contents!).servers[0].secret).toBe(Buffer.from(`enc:${TOKEN}`).toString('base64'));

    const reopened = new ModelServerStore(cipher(), file, logger);
    const [saved] = await reopened.list();
    expect(saved).toMatchObject({ id: record.id, auth: { type: 'bearer' } });
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(reopened.headers(saved)).toEqual({ authorization: `Bearer ${TOKEN}` });
  });

  it('stores a custom header name in the clear and its value encrypted', async () => {
    const file = memoryFile();
    const store = new ModelServerStore(cipher(), file, logger);
    const record = await store.add(base, { type: 'header', name: 'X-Api-Key', value: HEADER_VALUE });
    expect(file.contents).toContain('X-Api-Key');
    expect(file.contents).not.toContain(HEADER_VALUE);
    expect(store.headers(record)).toEqual({ 'x-api-key': HEADER_VALUE });
  });

  it('keeps a credential for this run only when the keyring is unavailable', async () => {
    const file = memoryFile();
    const store = new ModelServerStore(cipher(false), file, logger);
    const record = await store.add(base, { type: 'bearer', token: TOKEN });
    expect(store.credentialPersisted()).toBe(false);
    expect(file.contents).not.toContain(TOKEN);
    expect(JSON.parse(file.contents!).servers[0].secret).toBeUndefined();
    expect(store.headers(record)).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(store.credentialMissing(record)).toBe(false);

    const restarted = new ModelServerStore(cipher(false), file, logger);
    const [saved] = await restarted.list();
    expect(restarted.headers(saved)).toBeNull();
    expect(restarted.credentialMissing(saved)).toBe(true);
  });

  it('logs a decrypt failure without the ciphertext or the secret', async () => {
    const file = memoryFile();
    await new ModelServerStore(cipher(), file, logger).add(base, { type: 'bearer', token: TOKEN });
    const broken: SecretCipher = {
      ...cipher(),
      decryptString: () => {
        throw new Error(`bad ${TOKEN}`);
      },
    };
    const store = new ModelServerStore(broken, file, logger);
    logger.warn.mockClear();
    logger.debug.mockClear();
    const [saved] = await store.list();
    expect(store.headers(saved)).toBeNull();
    const logged = [...logger.warn.mock.calls, ...logger.debug.mock.calls].flat().join('\n');
    expect(logged).toContain('gpu box');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(JSON.parse(file.contents!).servers[0].secret);
  });

  it('drops the old secret when the credential is changed to none', async () => {
    const file = memoryFile();
    const store = new ModelServerStore(cipher(), file, logger);
    const record = await store.add(base, { type: 'bearer', token: TOKEN });
    const updated = await store.update(record.id, { credential: { type: 'none' } });
    expect(updated.auth).toEqual({ type: 'none' });
    expect(store.headers(updated)).toBeNull();
    expect(JSON.parse(file.contents!).servers[0].secret).toBeUndefined();
  });

  it('keeps fields and records a later version wrote when it rewrites the file', async () => {
    const file = memoryFile(
      JSON.stringify({
        version: 1,
        extra: { kept: true },
        servers: [
          { ...base, id: 'aaaaaaaaaaaa', auth: { type: 'none' }, contextTokens: 32768 },
          {
            id: 'bbbbbbbbbbbb',
            name: 'ssh box',
            kind: 'ollama',
            transport: { type: 'ssh', host: 'box' },
            access: 'manage',
            auth: { type: 'none' },
          },
          {
            id: 'cccccccccccc',
            name: 'future',
            kind: 'vllm',
            transport: { type: 'http', baseUrl: 'https://f.example.test' },
            access: 'chat',
            auth: { type: 'none' },
          },
        ],
      })
    );
    const store = new ModelServerStore(cipher(), file, logger);
    expect((await store.list()).map(server => server.id)).toEqual(['aaaaaaaaaaaa']);
    await store.update('aaaaaaaaaaaa', { access: 'manage' });
    const written = JSON.parse(file.contents!);
    expect(written.extra).toEqual({ kept: true });
    expect(written.servers[0]).toMatchObject({ access: 'manage', contextTokens: 32768 });
    expect(written.servers[1].transport).toEqual({ type: 'ssh', host: 'box' });
    expect(written.servers[2].kind).toBe('vllm');
  });

  it('keeps a record without a string id when it rewrites the file', async () => {
    const orphan = { name: 'companion', kind: 'companion' };
    const file = memoryFile(
      JSON.stringify({ version: 1, servers: [{ ...base, id: 'aaaaaaaaaaaa', auth: { type: 'none' } }, orphan] })
    );
    const store = new ModelServerStore(cipher(), file, logger);
    await store.update('aaaaaaaaaaaa', { access: 'manage' });
    const written = JSON.parse(file.contents!);
    expect(written.servers).toHaveLength(2);
    expect(written.servers).toContainEqual(orphan);
  });

  it('uses a file from a newer version read-only and never rewrites it', async () => {
    const original = JSON.stringify({
      version: 2,
      servers: [{ ...base, id: 'aaaaaaaaaaaa', auth: { type: 'none' } }],
    });
    const file = memoryFile(original);
    const warn = vi.fn();
    const store = new ModelServerStore(cipher(), file, { debug: vi.fn(), warn });
    expect((await store.list()).map(server => server.id)).toEqual(['aaaaaaaaaaaa']);
    await expect(store.update('aaaaaaaaaaaa', { access: 'manage' })).rejects.toThrow(/newer Desktop/);
    await expect(store.add({ ...base, name: 'other' }, { type: 'none' })).rejects.toThrow(/newer Desktop/);
    await expect(store.remove('aaaaaaaaaaaa')).rejects.toThrow(/newer Desktop/);
    await store.setModels('aaaaaaaaaaaa', ['m1']);
    expect(file.contents).toBe(original);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/version 2/);
  });

  it('refuses a duplicate name, including the name of this computer', async () => {
    const store = new ModelServerStore(cipher(), memoryFile(), logger);
    await store.add(base, { type: 'none' });
    await expect(store.add({ ...base, name: 'GPU  Box' }, { type: 'none' })).rejects.toThrow(/already called/);
    await expect(store.add({ ...base, name: 'this computer' }, { type: 'none' })).rejects.toThrow(/already called/);
  });

  it(`stops at ${MAX_MODEL_SERVERS} servers`, async () => {
    const store = new ModelServerStore(cipher(), memoryFile(), logger);
    for (let index = 0; index < MAX_MODEL_SERVERS; index++) {
      await store.add({ ...base, name: `box ${index}` }, { type: 'none' });
    }
    await expect(store.add({ ...base, name: 'one more' }, { type: 'none' })).rejects.toThrow(/at most/);
  });
});

describe('credentialHeaders', () => {
  it('builds the header each credential type sends', () => {
    expect(credentialHeaders({ type: 'none' })).toBeNull();
    expect(credentialHeaders({ type: 'bearer', token: ` ${TOKEN} ` })).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(credentialHeaders({ type: 'header', name: 'X-Key', value: HEADER_VALUE })).toEqual({
      'x-key': HEADER_VALUE,
    });
  });

  it('refuses header names that would change the request itself', () => {
    for (const name of ['Host', 'Content-Length', 'Cookie', 'Transfer-Encoding']) {
      expect(() => credentialHeaders({ type: 'header', name, value: 'v' })).toThrow(/cannot carry/);
    }
    expect(() => credentialHeaders({ type: 'header', name: 'Bad Name', value: 'v' })).toThrow(/header name/);
  });

  it('refuses values that could split a header, without echoing them', () => {
    const value = `${HEADER_VALUE}\r\nX-Injected: 1`;
    let message = '';
    try {
      credentialHeaders({ type: 'header', name: 'X-Key', value });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/not allow/);
    expect(message).not.toContain(HEADER_VALUE);
    expect(() => credentialHeaders({ type: 'bearer', token: 'two words' })).toThrow(/not allow/);
    for (const control of ['\x01', '\x1f', '\x7f']) {
      expect(() => credentialHeaders({ type: 'header', name: 'X-Key', value: `a${control}b` })).toThrow(
        /control character/
      );
      expect(() => credentialHeaders({ type: 'bearer', token: `a${control}b` })).toThrow(/control character/);
    }
    expect(credentialHeaders({ type: 'header', name: 'X-Key', value: 'a\tb' })).toEqual({ 'x-key': 'a\tb' });
    expect(() => credentialHeaders({ type: 'bearer', token: '   ' })).toThrow(/Enter the token/);
  });

  it('writes overlapping model-list updates one after another', async () => {
    let active = 0;
    let overlapped = false;
    const file: StoreFile = {
      read: () => Promise.resolve(null),
      write: async () => {
        overlapped ||= ++active > 1;
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
      },
    };
    const store = new ModelServerStore(cipher(), file, logger);
    const one = await store.add(base, { type: 'none' });
    const two = await store.add({ ...base, name: 'second' }, { type: 'none' });
    await Promise.all([store.setModels(one.id, ['a', 'b']), store.setModels(two.id, ['c'])]);
    expect(overlapped).toBe(false);
  });
});
