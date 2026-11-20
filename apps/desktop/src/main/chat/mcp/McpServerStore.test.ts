import { describe, expect, it, vi } from 'vitest';
import { openedAs, versionedCipher } from '../../secrets/versionedCipher.testHelper';
import { McpServerStore, type SecretCipher, type StoreFile } from './McpServerStore';

// Non-hex on purpose: the store writes random UUID ids into the same file the not.toContain checks scan.
const SECRET = 'tok-secret-zz';

/** Reversible stand-in for safeStorage: readable in a test, opaque in the file. */
function cipher(available = true): SecretCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: plain => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: encrypted => encrypted.toString('utf8').replace(/^enc:/, ''),
  };
}

function memoryFile(): StoreFile & { contents: string | null } {
  return {
    contents: null,
    read() {
      return Promise.resolve(this.contents);
    },
    write(next: string) {
      this.contents = next;
      return Promise.resolve();
    },
  };
}

const logger = { debug: () => undefined, warn: () => undefined };

describe('McpServerStore', () => {
  it('never writes a secret value in plain text', async () => {
    const file = memoryFile();
    const store = new McpServerStore(cipher(), file, logger);
    await store.add({ name: 'gh', transport: 'stdio', command: 'node', env: { TOKEN: 'super-secret-value' } });

    expect(file.contents).not.toContain('super-secret-value');
    // The variable NAME is not a credential and stays readable, so the dialog can say it is set.
    expect(file.contents).toContain('TOKEN');
  });

  it('reads secrets back through the cipher', async () => {
    const file = memoryFile();
    await new McpServerStore(cipher(), file, logger).add({
      name: 'gh',
      transport: 'stdio',
      command: 'node',
      env: { TOKEN: SECRET },
    });

    const reopened = new McpServerStore(cipher(), file, logger);
    expect((await reopened.list())[0].env).toEqual({ TOKEN: SECRET });
  });

  it('keeps secrets in memory and off disk when there is no keychain', async () => {
    const file = memoryFile();
    const store = new McpServerStore(cipher(false), file, logger);
    const added = await store.add({ name: 'gh', transport: 'stdio', command: 'node', env: { TOKEN: SECRET } });

    expect(added.env).toEqual({ TOKEN: SECRET });
    expect(store.secretsPersisted()).toBe(false);
    expect(file.contents).not.toContain(SECRET);
    // Gone on the next launch rather than written in the clear.
    expect((await new McpServerStore(cipher(false), file, logger).list())[0].env).toEqual({});
  });

  it('keeps stored secrets when an update omits them', async () => {
    const store = new McpServerStore(cipher(), memoryFile(), logger);
    const added = await store.add({ name: 'gh', transport: 'stdio', command: 'node', env: { TOKEN: SECRET } });

    const updated = await store.update(added.id, { name: 'github', transport: 'stdio', command: 'node' });
    expect(updated.name).toBe('github');
    expect(updated.env).toEqual({ TOKEN: SECRET });
  });

  it('replaces stored secrets when an update sends them', async () => {
    const store = new McpServerStore(cipher(), memoryFile(), logger);
    const added = await store.add({ name: 'gh', transport: 'stdio', command: 'node', env: { TOKEN: SECRET } });

    const updated = await store.update(added.id, {
      name: 'gh',
      transport: 'stdio',
      command: 'node',
      env: { OTHER: 'xyz' },
    });
    expect(updated.env).toEqual({ OTHER: 'xyz' });
  });

  it('survives a keychain that can no longer decrypt', async () => {
    const file = memoryFile();
    await new McpServerStore(cipher(), file, logger).add({
      name: 'gh',
      transport: 'stdio',
      command: 'node',
      env: { TOKEN: SECRET },
    });

    const broken: SecretCipher = {
      ...cipher(),
      decryptString: () => {
        throw new Error('keychain rotated');
      },
    };
    const servers = await new McpServerStore(broken, file, logger).list();
    // The server is kept so the user can fix it, with its secrets dropped rather than guessed.
    expect(servers).toHaveLength(1);
    expect(servers[0].env).toEqual({});
  });

  it('refuses a duplicate name, which would collide in the tool namespace', async () => {
    const store = new McpServerStore(cipher(), memoryFile(), logger);
    await store.add({ name: 'gh', transport: 'stdio', command: 'node' });
    await expect(store.add({ name: 'GH', transport: 'stdio', command: 'node' })).rejects.toThrow(/already called/);
  });

  it('refuses a config that cannot work', async () => {
    const store = new McpServerStore(cipher(), memoryFile(), logger);
    await expect(store.add({ name: '', transport: 'stdio', command: 'node' })).rejects.toThrow(/name/);
    await expect(store.add({ name: 'a', transport: 'stdio' })).rejects.toThrow(/command/);
    await expect(store.add({ name: 'b', transport: 'http', url: 'file:///etc/passwd' })).rejects.toThrow(
      /http or https/
    );
    await expect(store.add({ name: 'c', transport: 'http', url: 'http://example.com/mcp' })).rejects.toThrow(/https/);
  });

  it('allows plain http on loopback, where there is nothing to intercept', async () => {
    const store = new McpServerStore(cipher(), memoryFile(), logger);
    await expect(
      store.add({ name: 'local', transport: 'http', url: 'http://localhost:9000/mcp' })
    ).resolves.toBeTruthy();
  });

  it('drops prototype keys out of an env map', async () => {
    const store = new McpServerStore(cipher(), memoryFile(), logger);
    const added = await store.add({
      name: 'gh',
      transport: 'stdio',
      command: 'node',
      env: JSON.parse('{"__proto__":"x","OK":"y"}') as Record<string, string>,
    });
    expect(Object.keys(added.env)).toEqual(['OK']);
  });

  it('stores who added a server as plain metadata, and keeps it through an edit and a reload', async () => {
    const file = memoryFile();
    const store = new McpServerStore(cipher(), file, logger);
    const addedBy = { sessionId: 's-1', sessionTitle: 'Chair blueprint', addedAt: '2026-10-09T00:00:00.000Z' };
    const record = await store.add(
      { name: 'cad', transport: 'stdio', command: 'node', env: { KEY: 'v4lue' } },
      addedBy
    );
    await store.update(record.id, { name: 'cad', transport: 'stdio', command: 'node', args: ['--flag'] });

    expect(file.contents).toContain('Chair blueprint');
    const reloaded = new McpServerStore(cipher(), file, logger);
    expect((await reloaded.get(record.id))?.addedBy).toEqual(addedBy);
  });
});

describe('McpServerStore.reencrypt', () => {
  async function legacyFile() {
    const file = memoryFile();
    const legacy = new McpServerStore(versionedCipher('old'), file, logger);
    await legacy.add({ name: 'gh', transport: 'stdio', command: 'node', env: { TOKEN: SECRET } });
    await legacy.add({ name: 'plain', transport: 'stdio', command: 'node' });
    return file;
  }
  const sealed = (file: { contents: string | null }) =>
    (JSON.parse(file.contents ?? '{}') as { servers: { name: string; secrets?: string }[] }).servers.map(server => [
      server.name,
      server.secrets && openedAs(server.secrets).slice(0, 4),
    ]);

  it('re-seals legacy secrets once, and they still read back', async () => {
    const file = await legacyFile();
    const writes = vi.spyOn(file, 'write');
    const store = new McpServerStore(versionedCipher('new'), file, logger);

    await store.reencrypt();
    await store.reencrypt();

    expect(sealed(file)).toEqual([
      ['gh', 'new:'],
      ['plain', undefined],
    ]);
    expect(writes).toHaveBeenCalledTimes(1);
    const reopened = await new McpServerStore(versionedCipher('new'), file, logger).list();
    expect(reopened.find(server => server.name === 'gh')?.env).toEqual({ TOKEN: SECRET });
  });

  it('keeps a legacy blob it cannot open, so nothing is lost', async () => {
    const file = await legacyFile();
    const before = file.contents;
    const writes = vi.spyOn(file, 'write');

    await new McpServerStore(versionedCipher('new', { opensOld: false }), file, logger).reencrypt();

    expect(writes).not.toHaveBeenCalled();
    expect(file.contents).toBe(before);
  });

  it('does nothing without a keychain, or with a cipher that asks for no migration', async () => {
    for (const current of [versionedCipher('new', { available: false }), cipher()]) {
      const file = await legacyFile();
      const writes = vi.spyOn(file, 'write');

      await new McpServerStore(current, file, logger).reencrypt();

      expect(writes).not.toHaveBeenCalled();
    }
  });
});
