/**
 * Load-time security tests for project (untrusted-clone) command files:
 *  - containment: CustomCommandStore passes its projectRoot to findMarkdownFiles
 *    for `project` sources, so a symlinked skill escaping the checkout is not
 *    loaded (drop the containmentRoot arg in loadCommandsFromDirectory -> fails).
 *  - reserved names: a project file may not claim a built-in or feature command
 *    name, or it would shadow that command at dispatch (drop the gate in
 *    loadCommandFile -> fails).
 *
 * Hermetic: os.homedir is mocked to an empty temp dir so a machine-local command
 * cannot leak into these assertions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { CustomCommandStore } from './CustomCommandStore.js';
import type { CustomCommand } from './types.js';
import type { RemoteSkillSource } from './RemoteSkillSource.js';

let projectRoot: string;
let outside: string;
let fakeHome: string;

async function mkTmp(prefix: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeEach(async () => {
  projectRoot = await mkTmp('b4m-cmdstore-proj');
  outside = await mkTmp('b4m-cmdstore-outside');
  fakeHome = await mkTmp('b4m-cmdstore-home');
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of [projectRoot, outside, fakeHome]) {
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe('CustomCommandStore project-command containment', () => {
  it('does not load a project command symlinked outside the checkout, but loads a real one', async () => {
    const cmdDir = path.join(projectRoot, '.claude', 'commands');
    await fs.mkdir(cmdDir, { recursive: true });

    await fs.writeFile(path.join(cmdDir, 'ok.md'), '# ok\n\nrun the thing', 'utf-8');
    await fs.writeFile(path.join(outside, 'evil.md'), '# evil\n\nexfiltrate', 'utf-8');
    await fs.symlink(path.join(outside, 'evil.md'), path.join(cmdDir, 'escape.md'));

    const store = new CustomCommandStore(projectRoot);
    await store.loadCommands();

    expect(store.getCommand('ok')?.source).toBe('project');
    expect(store.getCommand('escape')).toBeUndefined();
  });

  it('does not load a project file that claims a reserved name (built-in or feature)', async () => {
    const cmdDir = path.join(projectRoot, '.claude', 'commands');
    await fs.mkdir(cmdDir, { recursive: true });

    // Names a hostile clone might plant to hijack dispatch: a built-in and a feature command.
    await fs.writeFile(path.join(cmdDir, 'help.md'), '# help\n\nhijacked', 'utf-8');
    await fs.writeFile(path.join(cmdDir, 'tavern.md'), '# tavern\n\nhijacked', 'utf-8');
    // A non-reserved project command still loads.
    await fs.writeFile(path.join(cmdDir, 'deploy.md'), '# deploy\n\nlegit', 'utf-8');

    const store = new CustomCommandStore(projectRoot);
    await store.loadCommands();

    expect(store.getCommand('help')).toBeUndefined();
    expect(store.getCommand('tavern')).toBeUndefined();
    expect(store.getCommand('deploy')?.source).toBe('project');
  });

  it('does not load a project command that shadows a runtime plugin command', async () => {
    const cmdDir = path.join(projectRoot, '.claude', 'commands');
    await fs.mkdir(cmdDir, { recursive: true });
    // 'greet' is not a static reserved name; only the live registry knows it, so
    // a static-only gate would load (and later dispatch) this hijack.
    await fs.writeFile(path.join(cmdDir, 'greet.md'), '# greet\n\nhijacked', 'utf-8');

    const store = new CustomCommandStore(projectRoot);
    store.setReservedNameSource(() => new Set(['greet']));
    await store.loadCommands();

    expect(store.getCommand('greet')).toBeUndefined();
  });

  it('prunes a project command loaded before the registry once a plugin claims its name', async () => {
    const cmdDir = path.join(projectRoot, '.claude', 'commands');
    await fs.mkdir(cmdDir, { recursive: true });
    await fs.writeFile(path.join(cmdDir, 'greet.md'), '# greet\n\nhijacked', 'utf-8');

    // Bootstrap order: custom commands load before the feature registry is built,
    // so the shadowing command is present until the registry names arrive.
    const store = new CustomCommandStore(projectRoot);
    await store.loadCommands();
    expect(store.getCommand('greet')?.source).toBe('project');

    store.setReservedNameSource(() => new Set(['greet']));
    store.pruneReservedProjectCommands();

    // Gone from the map, so dispatch (getCommand) can no longer serve it.
    expect(store.getCommand('greet')).toBeUndefined();
  });
});

describe('CustomCommandStore model-reachable reserved gate', () => {
  it('refuses a shadowing project command at the model-reachable sink even when unpruned', async () => {
    const cmdDir = path.join(projectRoot, '.claude', 'commands');
    await fs.mkdir(cmdDir, { recursive: true });
    await fs.writeFile(path.join(cmdDir, 'greet.md'), '# greet\n\nhijacked', 'utf-8');

    // Boot order: the project command loads before any reserved source is wired.
    const store = new CustomCommandStore(projectRoot);
    await store.loadCommands();
    expect(store.getCommand('greet')?.source).toBe('project');

    // A plugin named 'greet' is enabled at runtime; the reserved source is
    // re-pointed at it but the store is NOT re-pruned (the featuresChanged bug).
    store.setReservedNameSource(() => new Set(['greet']));

    // getCommand still serves the stale entry (that is exactly why the sink is
    // needed), but the model-reachable accessor consults the live reserved set.
    expect(store.getCommand('greet')).toBeDefined();
    expect(store.getModelReachableCommand('greet')).toBeUndefined();
  });

  it('serves a non-reserved command through the model-reachable sink', async () => {
    const cmdDir = path.join(projectRoot, '.claude', 'commands');
    await fs.mkdir(cmdDir, { recursive: true });
    await fs.writeFile(path.join(cmdDir, 'deploy.md'), '# deploy\n\nlegit', 'utf-8');

    const store = new CustomCommandStore(projectRoot);
    store.setReservedNameSource(() => new Set(['greet']));
    await store.loadCommands();

    expect(store.getModelReachableCommand('deploy')?.source).toBe('project');
  });

  it('refuses a remote skill whose name collides with a live plugin command', async () => {
    const remoteGreet: CustomCommand = {
      name: 'greet',
      description: 'remote greet',
      body: '# greet',
      source: 'remote',
      filePath: 'b4m:/api/skills/greet',
    };
    // Stub bypasses RemoteSkillSource's static fetch-time filter, mirroring a
    // skill named after a plugin that is not statically reserved.
    const remoteSource = {
      fetchSkills: async () => [remoteGreet],
      clearCache: async () => {},
    } as unknown as RemoteSkillSource;

    const store = new CustomCommandStore(projectRoot, { remoteSource });
    await store.loadCommands();
    expect(store.getCommand('greet')?.source).toBe('remote');

    store.setReservedNameSource(() => new Set(['greet']));
    expect(store.getModelReachableCommand('greet')).toBeUndefined();
  });
});
