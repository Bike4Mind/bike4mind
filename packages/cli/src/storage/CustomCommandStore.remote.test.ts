import { describe, it, expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { CustomCommandStore } from './CustomCommandStore.js';
import { RemoteSkillSource } from './RemoteSkillSource.js';
import type { ApiClient } from '../auth/ApiClient.js';

async function makeIsolatedProjectRoot(): Promise<string> {
  const dir = path.join(os.tmpdir(), `b4m-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeApiClient(skills: Array<{ id: string; name: string; description: string; body: string }>): ApiClient {
  return {
    get: vi.fn().mockResolvedValue({ data: skills }),
  } as unknown as ApiClient;
}

describe('CustomCommandStore with remote source', () => {
  it('loads remote skills when no local files exist', async () => {
    const projectRoot = await makeIsolatedProjectRoot();
    const cachePath = path.join(projectRoot, 'cache.json');
    const remoteSource = new RemoteSkillSource(
      makeApiClient([{ id: '1', name: 'summarize', description: 'd', body: 'remote-body' }]),
      { cacheFilePath: cachePath }
    );

    // Override the default home dirs by using a projectRoot that has no .claude/skills etc.
    const store = new CustomCommandStore(projectRoot, { remoteSource });
    await store.loadCommands();

    const summarize = store.getCommand('summarize');
    expect(summarize).toBeDefined();
    expect(summarize?.source).toBe('remote');
    expect(summarize?.body).toBe('remote-body');
  });

  it('lets a local project skill overwrite a remote skill with the same name', async () => {
    const projectRoot = await makeIsolatedProjectRoot();
    const cachePath = path.join(projectRoot, 'cache.json');

    // Plant a local project skill named "summarize"
    const skillsDir = path.join(projectRoot, '.claude', 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'summarize.md'),
      `---\ndescription: Local summarize\n---\n\nlocal-body`,
      'utf-8'
    );

    const remoteSource = new RemoteSkillSource(
      makeApiClient([{ id: '1', name: 'summarize', description: 'remote', body: 'remote-body' }]),
      { cacheFilePath: cachePath }
    );

    const store = new CustomCommandStore(projectRoot, { remoteSource });
    await store.loadCommands();

    const summarize = store.getCommand('summarize');
    expect(summarize).toBeDefined();
    // Local wins on name collision - body comes from disk, source is 'project'.
    expect(summarize?.source).toBe('project');
    expect(summarize?.body).toContain('local-body');
  });

  it('mergeRemoteCommands layers remote skills on top after local load', async () => {
    // Models the production wiring: CLI loads local files first, then once
    // auth is established it attaches the remote source and calls
    // mergeRemoteCommands.
    const projectRoot = await makeIsolatedProjectRoot();
    const cachePath = path.join(projectRoot, 'cache.json');

    // Local skill - should keep precedence over a same-named remote skill.
    const skillsDir = path.join(projectRoot, '.claude', 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'shared.md'), `---\ndescription: Local shared\n---\n\nlocal-body`, 'utf-8');

    // No remote source at construction; load local files only.
    const store = new CustomCommandStore(projectRoot);
    await store.loadCommands();
    expect(store.getCommand('shared')?.source).toBe('project');
    expect(store.getCommand('remote-only')).toBeUndefined();

    // Attach remote source AFTER local load, then merge.
    const remoteSource = new RemoteSkillSource(
      makeApiClient([
        { id: '1', name: 'shared', description: 'remote', body: 'remote-body' },
        { id: '2', name: 'remote-only', description: 'd', body: 'b' },
      ]),
      { cacheFilePath: cachePath }
    );
    store.setRemoteSource(remoteSource);
    await store.mergeRemoteCommands();

    // Local override survives the merge.
    expect(store.getCommand('shared')?.source).toBe('project');
    expect(store.getCommand('shared')?.body).toContain('local-body');
    // New remote-only skill is added.
    expect(store.getCommand('remote-only')?.source).toBe('remote');
  });

  it('reloadRemoteCommands refreshes only remote entries (local files untouched)', async () => {
    const projectRoot = await makeIsolatedProjectRoot();
    const cachePath = path.join(projectRoot, 'cache.json');

    // Local skill that must NOT be re-scanned by reloadRemoteCommands.
    const skillsDir = path.join(projectRoot, '.claude', 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'local-only.md'), `---\ndescription: Local\n---\n\nlocal-body`, 'utf-8');

    // First fetch returns one remote skill; second returns a different one.
    const apiClient = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ data: [{ id: '1', name: 'remote-v1', description: 'first', body: 'v1' }] })
        .mockResolvedValueOnce({ data: [{ id: '2', name: 'remote-v2', description: 'second', body: 'v2' }] }),
    } as unknown as ApiClient;

    const remoteSource = new RemoteSkillSource(apiClient, { cacheFilePath: cachePath, freshTtlMs: 0 });
    const store = new CustomCommandStore(projectRoot, { remoteSource });
    await store.loadCommands();

    expect(store.getCommand('local-only')?.source).toBe('project');
    expect(store.getCommand('remote-v1')?.source).toBe('remote');
    expect(store.getCommand('remote-v2')).toBeUndefined();

    // Reload: remote-v1 should be replaced by remote-v2; local-only stays.
    await store.reloadRemoteCommands();

    expect(store.getCommand('local-only')?.source).toBe('project');
    expect(store.getCommand('remote-v1')).toBeUndefined();
    expect(store.getCommand('remote-v2')?.source).toBe('remote');
  });

  it('continues to load local skills when the remote source throws', async () => {
    const projectRoot = await makeIsolatedProjectRoot();
    const skillsDir = path.join(projectRoot, '.claude', 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'local-only.md'), `---\ndescription: Local only\n---\n\nbody`, 'utf-8');

    // RemoteSkillSource whose underlying ApiClient throws - exercises the
    // try/catch in CustomCommandStore.loadCommands().
    const remoteSource = new RemoteSkillSource(
      { get: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as ApiClient,
      { cacheFilePath: path.join(projectRoot, 'cache.json') }
    );

    const store = new CustomCommandStore(projectRoot, { remoteSource });
    await store.loadCommands();

    // Local skill still loads.
    expect(store.getCommand('local-only')).toBeDefined();
  });
});
