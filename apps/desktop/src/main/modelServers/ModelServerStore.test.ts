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
      thinkers: { aaaaaaaaaaaa: [{ model: 'qwen3-8b' }] },
    });
    const file = memoryFile(original);
    const warn = vi.fn();
    const store = new ModelServerStore(cipher(), file, { debug: vi.fn(), warn });
    expect((await store.list()).map(server => server.id)).toEqual(['aaaaaaaaaaaa']);
    await expect(store.update('aaaaaaaaaaaa', { access: 'manage' })).rejects.toThrow(/newer Desktop/);
    await expect(store.add({ ...base, name: 'other' }, { type: 'none' })).rejects.toThrow(/newer Desktop/);
    await expect(store.remove('aaaaaaaaaaaa')).rejects.toThrow(/newer Desktop/);
    await store.setModels('aaaaaaaaaaaa', ['m1']);
    await store.addThinker('aaaaaaaaaaaa', 'phi-4');
    await store.forgetThinker('aaaaaaaaaaaa', 'qwen3-8b');
    expect(file.contents).toBe(original);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/version 2/);
  });

  it('refuses a duplicate name, including the name of this computer', async () => {
    const store = new ModelServerStore(cipher(), memoryFile(), logger);
    await store.add(base, { type: 'none' });
    await expect(store.add({ ...base, name: 'GPU  Box' }, { type: 'none' })).rejects.toThrow(/already called/);
    await expect(store.add({ ...base, name: 'this computer' }, { type: 'none' })).rejects.toThrow(/already called/);
  });

  describe('when the write fails', () => {
    function failingOnce(file = memoryFile()) {
      const write = file.write.bind(file);
      const state = { fail: false };
      file.write = (next: string) => {
        if (!state.fail) return write(next);
        state.fail = false;
        return Promise.reject(new Error('disk full'));
      };
      return { file, state };
    }

    it('does not list a server it could not save', async () => {
      const { file, state } = failingOnce();
      const store = new ModelServerStore(cipher(), file, logger);
      state.fail = true;
      await expect(store.add(base, { type: 'bearer', token: TOKEN })).rejects.toThrow(/disk full/);
      expect(await store.list()).toEqual([]);
      await expect(store.add(base, { type: 'none' })).resolves.toMatchObject({ name: 'gpu box' });
    });

    it('keeps the old credential when saving a new one fails', async () => {
      const { file, state } = failingOnce();
      const store = new ModelServerStore(cipher(), file, logger);
      const record = await store.add(base, { type: 'bearer', token: TOKEN });
      state.fail = true;
      await expect(
        store.update(record.id, { credential: { type: 'header', name: 'X-Api-Key', value: HEADER_VALUE } })
      ).rejects.toThrow(/disk full/);
      const [saved] = await store.list();
      expect(saved.auth).toEqual({ type: 'bearer' });
      expect(store.headers(saved)).toEqual({ authorization: `Bearer ${TOKEN}` });
      expect(store.headers(record)).toEqual({ authorization: `Bearer ${TOKEN}` });
    });

    it('keeps a server and its credential when removing it fails', async () => {
      const { file, state } = failingOnce();
      const store = new ModelServerStore(cipher(false), file, logger);
      const record = await store.add(base, { type: 'bearer', token: TOKEN });
      state.fail = true;
      await expect(store.remove(record.id)).rejects.toThrow(/disk full/);
      expect(await store.list()).toHaveLength(1);
      expect(store.headers(record)).toEqual({ authorization: `Bearer ${TOKEN}` });
    });

    it('keeps the entered hardware when saving new figures fails', async () => {
      const { file, state } = failingOnce();
      const store = new ModelServerStore(cipher(), file, logger);
      const record = await store.add(base, { type: 'none' });
      const specs = { ramGiB: 64, gpuMemoryGiB: 24, bandwidthGBps: null, unified: false };
      await store.update(record.id, { specs });
      await store.setLocalSpecs(specs);
      state.fail = true;
      await expect(store.update(record.id, { specs: { ...specs, ramGiB: 128 } })).rejects.toThrow(/disk full/);
      state.fail = true;
      await expect(store.setLocalSpecs(null)).rejects.toThrow(/disk full/);
      expect((await store.get(record.id))?.specs).toEqual(specs);
      expect(await store.localSpecs()).toEqual(specs);
    });
  });

  it('keeps both servers when two are added at once', async () => {
    const file = memoryFile();
    const store = new ModelServerStore(cipher(), file, logger);
    await Promise.all([store.add(base, { type: 'none' }), store.add({ ...base, name: 'second' }, { type: 'none' })]);
    expect((await store.list()).map(server => server.name).sort()).toEqual(['gpu box', 'second']);
    expect(JSON.parse(file.contents!).servers).toHaveLength(2);
  });

  it('saves, reads back and clears entered hardware for a server and for this computer', async () => {
    const file = memoryFile();
    const store = new ModelServerStore(cipher(), file, logger);
    const record = await store.add(base, { type: 'none' });
    expect(record.specs).toBeNull();
    const specs = { ramGiB: 128, gpuMemoryGiB: 96, bandwidthGBps: 256, unified: true };
    expect((await store.update(record.id, { specs })).specs).toEqual(specs);
    // This computer's probe decides unified memory, so the flag is not kept for it.
    expect(await store.setLocalSpecs({ ...specs, ramGiB: 64 })).toEqual({ ...specs, ramGiB: 64, unified: false });

    const reopened = new ModelServerStore(cipher(), file, logger);
    expect((await reopened.get(record.id))?.specs).toEqual(specs);
    expect(await reopened.localSpecs()).toEqual({ ...specs, ramGiB: 64, unified: false });

    await reopened.update(record.id, { specs: null });
    await reopened.setLocalSpecs({ ramGiB: null, gpuMemoryGiB: null, bandwidthGBps: null, unified: false });
    expect(JSON.parse(file.contents!).servers[0].specs).toBeUndefined();
    expect(JSON.parse(file.contents!).localSpecs).toBeUndefined();
  });

  it('refuses specs Settings should not send, and ignores a stored shape it cannot use', async () => {
    const store = new ModelServerStore(cipher(), memoryFile(), logger);
    const record = await store.add(base, { type: 'none' });
    const blank = { ramGiB: null, gpuMemoryGiB: null, bandwidthGBps: null, unified: false };
    await expect(store.update(record.id, { specs: { ...blank, gpuMemoryGiB: 24 } })).rejects.toThrow('Enter the RAM');
    await expect(store.update(record.id, { specs: { ...blank, ramGiB: -1 } })).rejects.toThrow('RAM');
    await expect(store.setLocalSpecs({ ...blank, bandwidthGBps: Number.NaN })).rejects.toThrow('bandwidth');
    // GPU memory alone is fine for this computer, whose probe supplies the RAM.
    expect(await store.setLocalSpecs({ ...blank, gpuMemoryGiB: 24 })).toEqual({ ...blank, gpuMemoryGiB: 24 });

    const odd = memoryFile(
      JSON.stringify({
        version: 1,
        servers: [{ ...base, id: 'abc', auth: { type: 'none' }, specs: { ramGiB: 'lots' } }],
        localSpecs: { ramGiB: 1e9 },
      })
    );
    const reopened = new ModelServerStore(cipher(), odd, logger);
    expect((await reopened.get('abc'))?.specs).toBeNull();
    expect(await reopened.localSpecs()).toBeNull();
  });

  it("keeps launch settings for this computer and each server across a restart, apart from the server's specs", async () => {
    const file = memoryFile();
    const store = new ModelServerStore(cipher(), file, logger);
    const record = await store.add(base, { type: 'none' });
    expect(store.localLaunch()).toEqual({});
    expect(store.launchSettings(record.id)).toEqual({});
    expect(await store.setLocalLaunch({ kvCacheType: 'q8_0', flashAttention: 'on' })).toEqual({
      kvCacheType: 'q8_0',
      flashAttention: 'on',
    });
    const specs = { ramGiB: 64, gpuMemoryGiB: null, bandwidthGBps: null, unified: false };
    await store.update(record.id, { specs, launch: { kvCacheType: 'q4_0' } });
    await store.update(record.id, { name: 'renamed' });

    const reopened = new ModelServerStore(cipher(), file, logger);
    expect((await reopened.get(record.id))?.specs).toEqual(specs);
    expect(reopened.localLaunch()).toEqual({ kvCacheType: 'q8_0', flashAttention: 'on' });
    expect(reopened.launchSettings(record.id)).toEqual({ kvCacheType: 'q4_0' });
    await reopened.setLocalLaunch({});
    await reopened.update(record.id, { launch: {} });
    const saved = JSON.parse(file.contents!);
    expect(saved.localLaunch).toBeUndefined();
    expect(saved.servers[0].launch).toBeUndefined();
  });

  it('drops launch settings when the server changes kind, since another program runs it', async () => {
    const store = new ModelServerStore(cipher(), memoryFile(), logger);
    const record = await store.add(base, { type: 'none' });
    await store.update(record.id, { launch: { kvCacheType: 'q8_0' } });
    await store.update(record.id, { kind: 'openai-compatible' });
    expect(store.launchSettings(record.id)).toEqual({});
    await store.update(record.id, { kind: 'ollama', launch: { flashAttention: 'off' } });
    expect(store.launchSettings(record.id)).toEqual({ flashAttention: 'off' });
  });

  describe('a KV cache type saved under Hardware', () => {
    const specs = { ramGiB: 64, gpuMemoryGiB: null, bandwidthGBps: null, unified: false };
    const server = {
      id: 'a1',
      name: 'spare',
      kind: 'ollama',
      transport: { type: 'http', baseUrl: 'http://127.0.0.1:11500' },
      access: 'chat',
      auth: { type: 'none' },
    };

    it('stays in Hardware for a remote or SSH Ollama, which Desktop cannot start', async () => {
      const remote = { ...server, transport: { type: 'http', baseUrl: 'http://10.0.0.5:11434' } };
      const ssh = { ...server, id: 'b2', transport: { type: 'ssh', destination: 'me@gpu' } };
      const file = memoryFile(
        JSON.stringify({
          version: 1,
          servers: [
            { ...remote, specs: { ...specs, kvCacheType: 'q4_0' } },
            { ...ssh, specs: { ...specs, kvCacheType: 'q8_0' } },
          ],
        })
      );
      const store = new ModelServerStore(cipher(), file, logger);
      expect((await store.get('a1'))?.specs).toEqual({ ...specs, kvCacheType: 'q4_0' });
      expect((await store.get('b2'))?.specs).toEqual({ ...specs, kvCacheType: 'q8_0' });
      expect(store.launchSettings('a1')).toEqual({});
      expect(store.launchSettings('b2')).toEqual({});

      await store.update('a1', { specs: { ...specs, kvCacheType: 'q8_0' } });
      const saved = JSON.parse(file.contents!);
      expect(saved.servers[0].specs).toEqual({ ...specs, kvCacheType: 'q8_0' });
      expect(saved.servers[0].launch).toBeUndefined();
      expect((await store.update('a1', { kind: 'openai-compatible' })).specs).toEqual(specs);
    });

    it('is not kept in Hardware for a server Desktop can start', async () => {
      const file = memoryFile(JSON.stringify({ version: 1, servers: [{ ...server, specs }] }));
      const store = new ModelServerStore(cipher(), file, logger);
      expect((await store.update('a1', { specs: { ...specs, kvCacheType: 'q8_0' } })).specs).toEqual(specs);
    });

    it('becomes the launch cache type of this computer and of a server with none', async () => {
      const file = memoryFile(
        JSON.stringify({
          version: 1,
          servers: [{ ...server, specs: { ...specs, kvCacheType: 'q4_0' } }],
          localSpecs: { ...specs, kvCacheType: 'q8_0' },
          localLaunch: { flashAttention: 'on' },
        })
      );
      const store = new ModelServerStore(cipher(), file, logger);
      expect(await store.localSpecs()).toEqual(specs);
      expect(store.localLaunch()).toEqual({ kvCacheType: 'q8_0', flashAttention: 'on' });
      expect(store.launchSettings('a1')).toEqual({ kvCacheType: 'q4_0' });
      expect((await store.get('a1'))?.specs).toEqual(specs);

      await store.update('a1', { name: 'renamed' });
      const saved = JSON.parse(file.contents!);
      expect(saved.servers[0].specs).toEqual(specs);
      expect(saved.servers[0].launch).toEqual({ kvCacheType: 'q4_0' });
    });

    it('leaves a cache type or flash attention setting saved under Launch as it is', async () => {
      const file = memoryFile(
        JSON.stringify({
          version: 1,
          servers: [
            { ...server, specs: { ...specs, kvCacheType: 'q4_0' }, launch: { kvCacheType: 'q8_0' } },
            { ...server, id: 'b2', specs: { ...specs, kvCacheType: 'q4_0' }, launch: { flashAttention: 'off' } },
          ],
          localSpecs: { ...specs, kvCacheType: 'q4_0' },
          localLaunch: { kvCacheType: 'q8_0' },
        })
      );
      const store = new ModelServerStore(cipher(), file, logger);
      await store.localSpecs();
      expect(store.localLaunch()).toEqual({ kvCacheType: 'q8_0' });
      expect(store.launchSettings('a1')).toEqual({ kvCacheType: 'q8_0' });
      expect(store.launchSettings('b2')).toEqual({ flashAttention: 'off' });
    });

    it('is not carried to a server that is not Ollama', async () => {
      const file = memoryFile(
        JSON.stringify({
          version: 1,
          servers: [{ ...server, kind: 'openai-compatible', specs: { ...specs, kvCacheType: 'q8_0' } }],
        })
      );
      const store = new ModelServerStore(cipher(), file, logger);
      await store.list();
      expect(store.launchSettings('a1')).toEqual({});
    });
  });

  it('remembers the models a server found thinking across a restart, and forgets them with the server', async () => {
    const file = memoryFile();
    const store = new ModelServerStore(cipher(), file, logger);
    const record = await store.add(base, { type: 'none' });
    await store.addThinker(record.id, 'qwen3-8b');
    const written = file.contents;
    await store.addThinker(record.id, 'qwen3-8b');
    await store.addThinker('gone', 'qwen3-8b');
    expect(file.contents).toBe(written);

    const reopened = new ModelServerStore(cipher(), file, logger);
    expect(await reopened.thinkers(record.id)).toEqual([{ model: 'qwen3-8b' }]);
    await reopened.remove(record.id);
    expect(await reopened.thinkers(record.id)).toEqual([]);
    expect(JSON.parse(file.contents!)).not.toHaveProperty('thinkers');
  });

  it('keeps the identity a thinker was learned with, replaces it, and forgets the model', async () => {
    const file = memoryFile();
    const store = new ModelServerStore(cipher(), file, logger);
    const record = await store.add(base, { type: 'none' });
    await store.addThinker(record.id, 'qwen3-8b', 'a');
    await store.addThinker(record.id, 'phi-4');
    await store.addThinker(record.id, 'qwen3-8b', 'b');
    expect(await new ModelServerStore(cipher(), file, logger).thinkers(record.id)).toEqual([
      { model: 'phi-4' },
      { model: 'qwen3-8b', identity: 'b' },
    ]);
    await store.forgetThinker(record.id, 'qwen3-8b');
    await store.forgetThinker(record.id, 'phi-4');
    expect(JSON.parse(file.contents!)).not.toHaveProperty('thinkers');
  });

  it('forgets the thinkers of a server whose kind changes', async () => {
    const file = memoryFile();
    const store = new ModelServerStore(cipher(), file, logger);
    const record = await store.add({ ...base, kind: 'openai-compatible' }, { type: 'none' });
    await store.addThinker(record.id, 'qwen3-8b');
    await store.update(record.id, { kind: 'openai-compatible', name: 'renamed' });
    expect(await store.thinkers(record.id)).toEqual([{ model: 'qwen3-8b' }]);
    await store.update(record.id, { kind: 'ollama' });
    expect(await new ModelServerStore(cipher(), file, logger).thinkers(record.id)).toEqual([]);
  });

  it('keeps only the latest thinkers per server', async () => {
    const store = new ModelServerStore(cipher(), memoryFile(), logger);
    const record = await store.add(base, { type: 'none' });
    for (let index = 0; index <= 200; index++) await store.addThinker(record.id, `model-${index}`);
    const kept = await store.thinkers(record.id);
    expect(kept).toHaveLength(200);
    expect(kept[0]).toEqual({ model: 'model-1' });
    expect(kept.at(-1)).toEqual({ model: 'model-200' });
  });

  it('reads only well-formed thinkers from a stored map', async () => {
    const file = memoryFile(
      JSON.stringify({
        version: 1,
        servers: [],
        thinkers: { a: ['qwen3', 7, null, { model: 'phi-4', identity: 'x' }, { model: 3 }], b: 'x' },
      })
    );
    const store = new ModelServerStore(cipher(), file, logger);
    expect(await store.thinkers('a')).toEqual([{ model: 'qwen3' }, { model: 'phi-4', identity: 'x' }]);
    expect(await store.thinkers('b')).toEqual([]);
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
