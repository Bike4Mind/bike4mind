import { promises as fsPromises } from 'fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
