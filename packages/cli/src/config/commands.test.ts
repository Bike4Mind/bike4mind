import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  mergeCommands,
  isReservedCommandName,
  wireReservedCommandNames,
  RESERVED_FEATURE_COMMANDS,
} from './commands.js';
import type { CustomCommand, CliConfig } from '../storage/types.js';
import type { CommandDefinition } from './commands.js';
import { createBuiltinModules } from '../features/createBuiltinModules.js';
import type { ApiClient } from '../auth/ApiClient.js';
import { CustomCommandStore } from '../storage/CustomCommandStore.js';

function custom(name: string): CustomCommand {
  return {
    name,
    description: `${name} desc`,
    body: `# ${name}`,
    source: 'project',
    filePath: `/proj/.claude/commands/${name}.md`,
  };
}

describe('mergeCommands', () => {
  it('drops a custom that shadows a live feature command, keeping the feature entry once', () => {
    const feature: CommandDefinition = { name: 'tavern', description: 'feature tavern' };
    const merged = mergeCommands([custom('tavern')], [feature]);

    const taverns = merged.filter(c => c.name === 'tavern');
    expect(taverns).toHaveLength(1);
    expect(taverns[0].description).toBe('feature tavern');
  });

  it('drops a custom that shadows a built-in, keeping the built-in', () => {
    const merged = mergeCommands([custom('help')]);
    const helps = merged.filter(c => c.name === 'help');
    expect(helps).toHaveLength(1);
    expect(helps[0].source).toBe('built-in');
  });

  it('keeps a non-reserved custom command', () => {
    const merged = mergeCommands([custom('deploy')]);
    const deploy = merged.find(c => c.name === 'deploy');
    expect(deploy).toBeDefined();
    expect(deploy!.source).toBe('project');
  });

  it('filters a custom whose name matches a passed feature name even if not statically reserved', () => {
    // A plugin can register a name not in RESERVED_FEATURE_COMMANDS; the passed
    // featureCommands union must still shadow a custom of that name.
    const merged = mergeCommands([custom('greet')], [{ name: 'greet', description: 'plugin greet' }]);
    const greets = merged.filter(c => c.name === 'greet');
    expect(greets).toHaveLength(1);
    expect(greets[0].description).toBe('plugin greet');
  });
});

describe('RESERVED_FEATURE_COMMANDS drift guard', () => {
  it('lists exactly the slash commands the built-in feature modules register', () => {
    // Derive the names from the real modules so adding/renaming a feature command
    // without updating RESERVED_FEATURE_COMMANDS (which the fetch-time and merge
    // filters depend on) fails here instead of silently voiding those filters.
    // Enable EVERY feature flag (Proxy returns true for any key) so a newly added
    // built-in module is constructed too - hardcoding {tavern, hearth} would let a
    // future built-in's commands escape this guard entirely.
    const config = { features: new Proxy({}, { get: () => true }) } as unknown as CliConfig;
    // getCommands() never touches the apiClient, so a bare stub is enough.
    const modules = createBuiltinModules(config, {} as ApiClient);
    const featureNames = new Set(modules.flatMap(m => (m.getCommands?.() ?? []).map(c => c.name)));

    expect(featureNames).toEqual(new Set(RESERVED_FEATURE_COMMANDS));
    for (const name of featureNames) {
      expect(isReservedCommandName(name)).toBe(true);
    }
  });
});

describe('wireReservedCommandNames', () => {
  // The two index.tsx wiring sites (bootstrap + plugin hot-reload) route through
  // this helper; index.tsx is imported by no test, so the helper is what pins the
  // re-wire. Deleting its body (the reviewer's mutation) leaves a shadowing project
  // command served from BOTH getCommand and getModelReachableCommand -> fails here.
  let projectRoot: string;
  let fakeHome: string;

  async function mkTmp(prefix: string): Promise<string> {
    const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  beforeEach(async () => {
    projectRoot = await mkTmp('b4m-wire-proj');
    fakeHome = await mkTmp('b4m-wire-home');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of [projectRoot, fakeHome]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  it('points the store gate at the registry and prunes a project command that shadows a plugin', async () => {
    const cmdDir = path.join(projectRoot, '.claude', 'commands');
    await fs.mkdir(cmdDir, { recursive: true });
    // 'greet' is not statically reserved; only the live registry names it, so it
    // loads at boot (before the registry is wired), exactly as in production.
    await fs.writeFile(path.join(cmdDir, 'greet.md'), '# greet\n\nhijacked', 'utf-8');

    const store = new CustomCommandStore(projectRoot);
    store.setProjectTrusted(true);
    await store.loadCommands();
    expect(store.getCommand('greet')?.source).toBe('project');

    // A registry whose commands include a plugin named 'greet'.
    wireReservedCommandNames(store, { getAllCommands: () => [{ name: 'greet' }] });

    // Both the dispatch sink (getCommand, post-prune) and the model-reachable sink
    // (live reserved gate) must now refuse it.
    expect(store.getCommand('greet')).toBeUndefined();
    expect(store.getModelReachableCommand('greet')).toBeUndefined();
  });
});

describe('isReservedCommandName with runtime feature names', () => {
  it('treats a live plugin command name as reserved only when the runtime set includes it', () => {
    // A plugin can register a name outside RESERVED_FEATURE_COMMANDS; the static
    // check alone misses it (this is the load/dispatch gap round 3 flagged).
    expect(isReservedCommandName('greet')).toBe(false);
    expect(isReservedCommandName('greet', new Set(['greet']))).toBe(true);
  });

  it('still reports static reserved names without a runtime set', () => {
    expect(isReservedCommandName('help')).toBe(true);
    expect(isReservedCommandName('tavern')).toBe(true);
  });
});
