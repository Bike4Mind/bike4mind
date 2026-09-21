import { describe, it, expect } from 'vitest';
import { mergeCommands, isReservedCommandName, RESERVED_FEATURE_COMMANDS } from './commands.js';
import type { CustomCommand, CliConfig } from '../storage/types.js';
import type { CommandDefinition } from './commands.js';
import { createBuiltinModules } from '../features/createBuiltinModules.js';
import type { ApiClient } from '../auth/ApiClient.js';

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
    const config = { features: { tavern: true, hearth: true } } as unknown as CliConfig;
    // getCommands() never touches the apiClient, so a bare stub is enough.
    const modules = createBuiltinModules(config, {} as ApiClient);
    const featureNames = new Set(modules.flatMap(m => (m.getCommands?.() ?? []).map(c => c.name)));

    expect(featureNames).toEqual(new Set(RESERVED_FEATURE_COMMANDS));
    for (const name of featureNames) {
      expect(isReservedCommandName(name)).toBe(true);
    }
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
