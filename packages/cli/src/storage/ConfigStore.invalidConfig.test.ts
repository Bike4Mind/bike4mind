import { promises as fsPromises } from 'fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelSavePatch } from '../utils/performModelSwitch.js';
import { ConfigStore } from './ConfigStore.js';

const signIn = {
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  userId: 'u',
};

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-invalid-config-'));
  configPath = path.join(dir, 'config.json');
  vi.stubEnv('HOME', dir);
  vi.stubEnv('B4M_NO_PROJECT_CONFIG', '1');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const readJson = async () => JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;

describe('saving over a config this build cannot validate', () => {
  it('keeps a partial config and adds only the model a /model save chose', async () => {
    await writeFile(configPath, JSON.stringify({ auth: signIn }), { mode: 0o600 });
    const store = new ConfigStore(configPath);
    const config = await store.load();

    await store.save(modelSavePatch({ id: 'llama3.2' }, config, null));

    expect(await readJson()).toEqual({ auth: signIn, defaultModel: 'llama3.2' });
  });

  it('keeps an invalid value and unknown keys exactly, and adds the trusted tool to the saved list', async () => {
    const preferences = { theme: 'sepia', temperature: 0.4, autoSave: true, exportFormat: 'markdown' };
    const newerSetting = { level: 3, modes: ['a', 'b'] };
    await writeFile(
      configPath,
      JSON.stringify({ userId: 'user-1', defaultModel: 'm', preferences, trustedTools: ['web_search'], newerSetting }),
      { mode: 0o600 }
    );

    await new ConfigStore(configPath).trustTool('file_read');

    const file = await readJson();
    expect(JSON.stringify(file.preferences)).toBe(JSON.stringify(preferences));
    expect(JSON.stringify(file.newerSetting)).toBe(JSON.stringify(newerSetting));
    expect(file).toEqual({
      userId: 'user-1',
      defaultModel: 'm',
      preferences,
      trustedTools: ['web_search', 'file_read'],
      newerSetting,
    });
  });

  it('keeps keys named like object internals as plain data', async () => {
    await writeFile(
      configPath,
      '{"preferences": {"theme": "sepia"}, "__proto__": {"polluted": true}, "features": {"constructor": true}}',
      { mode: 0o600 }
    );

    await new ConfigStore(configPath).save({ defaultModel: 'llama3.2' });

    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('"__proto__": {\n    "polluted": true\n  }');
    expect(text).toContain('"constructor": true');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('refuses a change that would replace a value of another shape, and leaves the file unchanged', async () => {
    const contents = JSON.stringify({ preferences: { theme: 'sepia' }, trustedTools: { bash: true } }, null, 2);
    await writeFile(configPath, contents, { mode: 0o600 });

    await expect(new ConfigStore(configPath).trustTool('file_read')).rejects.toThrow(`${configPath} failed validation`);
    expect(await readFile(configPath, 'utf-8')).toBe(contents);
  });

  it('drops a refused change, so a later unrelated save writes only its own change', async () => {
    await writeFile(configPath, JSON.stringify({ preferences: { theme: 'sepia' }, trustedTools: 'notalist' }), {
      mode: 0o600,
    });
    const store = new ConfigStore(configPath);

    await expect(store.trustTool('file_read')).rejects.toThrow(`${configPath} failed validation`);
    await store.save({ preferences: { exportFormat: 'json' } });

    expect(await readJson()).toEqual({
      preferences: { theme: 'sepia', exportFormat: 'json' },
      trustedTools: 'notalist',
    });
  });

  it('writes an item once when the in-memory copy holds an undefined key', async () => {
    await writeFile(configPath, JSON.stringify({ preferences: { theme: 'sepia' }, mcpServers: [] }), { mode: 0o600 });
    const store = new ConfigStore(configPath);
    await store.addMcpServer({
      name: 'local',
      command: 'local-mcp',
      args: [],
      env: {},
      enabled: true,
      headers: undefined,
    });

    await store.toggleMcpServer('local', false);

    expect((await readJson()).mcpServers).toEqual([
      { name: 'local', command: 'local-mcp', args: [], env: {}, enabled: false },
    ]);
  });

  it('clears a model server secret from the file', async () => {
    const credentials = { a: { secret: 'secret-a' }, b: { secret: 'secret-b' } };
    const contents = JSON.stringify({ preferences: { theme: 'sepia' }, modelServerCredentials: credentials });
    await writeFile(configPath, contents, { mode: 0o600 });

    await new ConfigStore(configPath).clearModelServerCredential('a');

    expect(await readJson()).toEqual({
      preferences: { theme: 'sepia' },
      modelServerCredentials: { b: { secret: 'secret-b' } },
    });
  });

  it('leaves a folder untrusted, with no repo layers loaded, when saving the trust fails', async () => {
    const projectDir = path.join(dir, 'proj');
    await mkdir(path.join(projectDir, '.git'), { recursive: true });
    await mkdir(path.join(projectDir, '.bike4mind'));
    await writeFile(path.join(projectDir, '.bike4mind', 'config.json'), JSON.stringify({ defaultModel: 'repo-model' }));
    await writeFile(configPath, JSON.stringify({ preferences: { theme: 'sepia' }, trustedProjects: 'notalist' }), {
      mode: 0o600,
    });
    vi.stubEnv('B4M_NO_PROJECT_CONFIG', '0');
    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      const store = new ConfigStore(configPath);
      await store.load();
      expect(store.getProjectConfigDir()).not.toBeNull();

      await expect(store.trustProject()).rejects.toThrow(`${configPath} failed validation`);

      expect(store.isProjectTrusted()).toBe(false);
      expect((store as unknown as { rawProjectConfig: unknown }).rawProjectConfig).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('refuses a save over a file that does not hold a JSON object, and leaves it unchanged', async () => {
    await writeFile(configPath, '["not", "a", "config"]', { mode: 0o600 });

    await expect(new ConfigStore(configPath).save({ defaultModel: 'x' })).rejects.toThrow(
      `${configPath} failed validation`
    );
    expect(await readFile(configPath, 'utf-8')).toBe('["not", "a", "config"]');
  });
});

describe('MCP servers in a config this build cannot validate', () => {
  // The bad theme is what fails validation; the servers themselves are fine.
  const preferences = { theme: 'sepia' };
  const github = { command: 'gh-mcp', env: { TOKEN: 'token-1' } };
  const local = { name: 'local', command: 'local-mcp', args: [], env: {}, enabled: true };
  const listBefore = [
    { name: 'local', command: 'old-mcp' },
    { name: 'github', ...github },
  ];

  it('adds a server to the name-keyed form and keeps the others with their env', async () => {
    await writeFile(configPath, JSON.stringify({ preferences, mcpServers: { github } }), { mode: 0o600 });

    await new ConfigStore(configPath).addMcpServer(local);

    const { name: _name, ...localEntry } = local;
    expect(await readJson()).toEqual({ preferences, mcpServers: { github, local: localEntry } });
  });

  it.each([
    ['list', listBefore, [{ name: 'github', ...github }, local]],
    [
      'name-keyed',
      { local: { command: 'old-mcp' }, github },
      { local: { command: 'local-mcp', args: [], env: {}, enabled: true }, github },
    ],
  ])('replaces a server of the same name in the %s form', async (_form, before, after) => {
    await writeFile(configPath, JSON.stringify({ preferences, mcpServers: before }), { mode: 0o600 });

    await new ConfigStore(configPath).addMcpServer(local);

    expect((await readJson()).mcpServers).toEqual(after);
  });

  it.each([
    ['list', listBefore, [{ name: 'github', ...github }]],
    ['name-keyed', { local: { command: 'old-mcp' }, github }, { github }],
  ])('removes a server by name in the %s form', async (_form, before, after) => {
    await writeFile(configPath, JSON.stringify({ preferences, mcpServers: before }), { mode: 0o600 });

    await new ConfigStore(configPath).removeMcpServer('local');

    expect(await readJson()).toEqual({ preferences, mcpServers: after });
  });
});

describe('revoking in a config this build cannot validate', () => {
  const preferences = { theme: 'sepia' };

  it('/untrust removes the tool from the saved list', async () => {
    await writeFile(configPath, JSON.stringify({ preferences, trustedTools: ['bash', 'file_read'] }), { mode: 0o600 });

    await new ConfigStore(configPath).untrustTool('bash');

    expect(await readJson()).toEqual({ preferences, trustedTools: ['file_read'] });
  });

  it('clearing trusted tools empties the saved list', async () => {
    await writeFile(configPath, JSON.stringify({ preferences, trustedTools: ['bash', 'file_read'] }), { mode: 0o600 });

    await new ConfigStore(configPath).clearTrustedTools();

    expect(await readJson()).toEqual({ preferences, trustedTools: [] });
  });

  it('untrusting a folder removes it and its MCP approvals', async () => {
    const root = await realpath(dir);
    const other = path.join(root, 'other');
    await writeFile(
      configPath,
      JSON.stringify({
        preferences,
        trustedProjects: [root, other],
        trustedMcpDefinitions: { [root]: { files: 'hash-1' }, [other]: { files: 'hash-2' } },
      }),
      { mode: 0o600 }
    );

    await new ConfigStore(configPath).untrustProject(root);

    expect(await readJson()).toEqual({
      preferences,
      trustedProjects: [other],
      trustedMcpDefinitions: { [other]: { files: 'hash-2' } },
    });
  });

  it('removing a directory drops it from the saved list', async () => {
    const kept = path.join(dir, 'kept');
    const removed = path.join(dir, 'removed');
    await writeFile(configPath, JSON.stringify({ preferences, additionalDirectories: [kept, removed] }), {
      mode: 0o600,
    });

    await new ConfigStore(configPath).removeDirectory(removed);

    expect(await readJson()).toEqual({ preferences, additionalDirectories: [kept] });
  });
});

describe('a save that cannot read the file part way through', () => {
  // A save reads the file for the sign-in fields, then the feature map, then the model fields.
  it.each([
    ['the feature map', 2, 'EBUSY'],
    ['the feature map', 2, 'EACCES'],
    ['the model fields', 3, 'EBUSY'],
  ])('fails when %s cannot be read (%s, %s) and leaves the file unchanged', async (_what, failingRead, code) => {
    const setup = new ConfigStore(configPath);
    await setup.save({ features: { alpha: true } });
    const contents = await readFile(configPath, 'utf-8');
    const store = new ConfigStore(configPath);
    await store.load();
    const realRead = fsPromises.readFile.bind(fsPromises);
    let reads = 0;
    vi.spyOn(fsPromises, 'readFile').mockImplementation((async (...args: Parameters<typeof realRead>) => {
      if (String(args[0]) === configPath && ++reads === failingRead) {
        throw Object.assign(new Error('read failed'), { code });
      }
      return realRead(...args);
    }) as typeof fsPromises.readFile);

    await expect(store.save({ defaultModel: 'other-model' })).rejects.toThrow(`Could not read ${configPath}: ${code}`);
    vi.mocked(fsPromises.readFile).mockRestore();

    expect(await readFile(configPath, 'utf-8')).toBe(contents);
  });
});

describe('after a refused save in a config this build cannot validate', () => {
  it('keeps a sign-in read from the file', async () => {
    await writeFile(configPath, JSON.stringify({ auth: signIn, trustedTools: 'notalist' }), { mode: 0o600 });
    const store = new ConfigStore(configPath);
    await store.reloadAuthTokens();

    await expect(store.trustTool('file_read')).rejects.toThrow(`${configPath} failed validation`);

    expect(await store.getAuthTokens()).toEqual(signIn);
  });

  it('keeps a backend address that was saved', async () => {
    await writeFile(configPath, JSON.stringify({ trustedTools: 'notalist' }), { mode: 0o600 });
    const store = new ConfigStore(configPath);
    await store.setCustomApiUrl('https://self.example.com');

    await expect(store.trustTool('file_read')).rejects.toThrow(`${configPath} failed validation`);

    expect((await store.load()).apiConfig?.customUrl).toBe('https://self.example.com');
  });

  it('keeps the sign-in and backend address after a save that failed reading the file', async () => {
    await writeFile(configPath, JSON.stringify({ auth: signIn, preferences: { theme: 'sepia' } }), { mode: 0o600 });
    const store = new ConfigStore(configPath);
    await store.reloadAuthTokens();
    await store.setCustomApiUrl('https://self.example.com');
    const realRead = fsPromises.readFile.bind(fsPromises);
    let failed = false;
    vi.spyOn(fsPromises, 'readFile').mockImplementation((async (...args: Parameters<typeof realRead>) => {
      if (!failed && String(args[0]) === configPath) {
        failed = true;
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      }
      return realRead(...args);
    }) as typeof fsPromises.readFile);

    await expect(store.save({ preferences: { exportFormat: 'json' } })).rejects.toThrow('EBUSY');

    expect(await store.getAuthTokens()).toEqual(signIn);
    expect((await store.load()).apiConfig?.customUrl).toBe('https://self.example.com');
    expect((await store.load()).preferences.exportFormat).toBe('markdown');
  });

  it('keeps changes other callers made while the refused save was in flight', async () => {
    await writeFile(configPath, JSON.stringify({ toolApiKeys: 'bad' }), { mode: 0o600 });
    const store = new ConfigStore(configPath);
    await store.trustTool('t1');
    const internals = store as unknown as { mergeOverInvalidConfig: (...args: unknown[]) => Promise<unknown> };
    const merge = internals.mergeOverInvalidConfig.bind(store);
    let entered!: () => void;
    const inside = new Promise<void>(resolve => (entered = resolve));
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    let calls = 0;
    internals.mergeOverInvalidConfig = async (...args: unknown[]) => {
      if (++calls === 1) {
        entered();
        await held;
      }
      return merge(...args);
    };

    const refused = store.save({ toolApiKeys: { serper: 'key-1' } });
    await inside;
    const untrusted = store.untrustTool('t1');
    const trusted = store.trustTool('t2');
    release();

    await expect(refused).rejects.toThrow(`${configPath} failed validation`);
    await untrusted;
    await trusted;
    expect(await readJson()).toEqual({ toolApiKeys: 'bad', trustedTools: ['t2'] });
    expect((await store.load()).trustedTools).toEqual(['t2']);
  });

  it('saves a change made while an earlier save was writing', async () => {
    await writeFile(configPath, JSON.stringify({ toolApiKeys: 'bad' }), { mode: 0o600 });
    const store = new ConfigStore(configPath);
    const internals = store as unknown as { mergeOverInvalidConfig: (...args: unknown[]) => Promise<unknown> };
    const merge = internals.mergeOverInvalidConfig.bind(store);
    let entered!: () => void;
    const inside = new Promise<void>(resolve => (entered = resolve));
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    let calls = 0;
    internals.mergeOverInvalidConfig = async (...args: unknown[]) => {
      const merged = await merge(...args);
      if (++calls === 1) {
        entered();
        await held;
      }
      return merged;
    };

    const first = store.save({ preferences: { theme: 'light' } });
    await inside;
    const trusted = store.trustTool('t1');
    release();

    await first;
    await trusted;
    expect(await readJson()).toEqual({ toolApiKeys: 'bad', preferences: { theme: 'light' }, trustedTools: ['t1'] });
  });

  it('keeps a change another caller made while the refused save waited its turn', async () => {
    await writeFile(configPath, JSON.stringify({ toolApiKeys: 'bad' }), { mode: 0o600 });
    const store = new ConfigStore(configPath);
    await store.trustTool('t1');
    const internals = store as unknown as { mergeOverInvalidConfig: (...args: unknown[]) => Promise<unknown> };
    const merge = internals.mergeOverInvalidConfig.bind(store);
    let entered!: () => void;
    const inside = new Promise<void>(resolve => (entered = resolve));
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    let calls = 0;
    internals.mergeOverInvalidConfig = async (...args: unknown[]) => {
      const merged = await merge(...args);
      if (++calls === 1) {
        entered();
        await held;
      }
      return merged;
    };

    const first = store.save({ preferences: { theme: 'light' } });
    await inside;
    const refused = store.save({ toolApiKeys: { serper: 'key-1' } });
    const trusted = store.trustTool('t2');
    release();

    await first;
    await expect(refused).rejects.toThrow(`${configPath} failed validation`);
    await trusted;
    expect((await readJson()).trustedTools).toEqual(['t1', 't2']);
    expect((await store.load()).trustedTools).toEqual(['t1', 't2']);
  });

  it('keeps changes other callers made while a save that failed for another reason was in flight', async () => {
    await writeFile(configPath, JSON.stringify({ toolApiKeys: 'bad' }), { mode: 0o600 });
    const store = new ConfigStore(configPath);
    await store.trustTool('t1');
    const internals = store as unknown as { mergeOverInvalidConfig: (...args: unknown[]) => Promise<unknown> };
    const merge = internals.mergeOverInvalidConfig.bind(store);
    let entered!: () => void;
    const inside = new Promise<void>(resolve => (entered = resolve));
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    let calls = 0;
    internals.mergeOverInvalidConfig = async (...args: unknown[]) => {
      if (++calls === 1) {
        entered();
        await held;
        throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      }
      return merge(...args);
    };

    const failed = store.save({ preferences: { exportFormat: 'json' } });
    await inside;
    const untrusted = store.untrustTool('t1');
    const trusted = store.trustTool('t2');
    release();

    await expect(failed).rejects.toThrow('resource busy');
    await untrusted;
    await trusted;
    expect(await readJson()).toEqual({ toolApiKeys: 'bad', trustedTools: ['t2'] });
    const config = await store.load();
    expect(config.trustedTools).toEqual(['t2']);
    expect(config.preferences.exportFormat).toBe('markdown');
  });
});
