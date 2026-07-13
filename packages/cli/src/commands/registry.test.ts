import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatch, builtinCommands } from './registry';
import type { CommandContext } from './types';
import { COMMANDS } from '../config/commands.js';

/**
 * Boundary tests for the command registry. They exercise routing and handler
 * effects with a fake CommandContext - no React/Ink render, which is the whole
 * point of extracting dispatch out of the root component.
 */

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  // Each fake implements only the slice its handler touches, so the store
  // fields are cast per-field. Keeping `base` typed as CommandContext (rather
  // than casting the whole object) means adding a new required field to the
  // interface fails this test until a fake is provided for it.
  const base: CommandContext = {
    configStore: {
      get: vi.fn(async () => ({ apiConfig: undefined })),
      getAdditionalDirectories: vi.fn(async () => [] as string[]),
    } as unknown as CommandContext['configStore'],
    customCommandStore: {
      getAllCommands: vi.fn(() => []),
    } as unknown as CommandContext['customCommandStore'],
    permissionManager: {
      getTrustedTools: vi.fn(() => [] as string[]),
    } as unknown as CommandContext['permissionManager'],
    decisionStore: { decisions: [] } as unknown as CommandContext['decisionStore'],
    blockerStore: { blockers: [] } as unknown as CommandContext['blockerStore'],
    reviewGateStore: { reviewGates: [] } as unknown as CommandContext['reviewGateStore'],
    openConfigEditor: vi.fn(),
  };
  return { ...base, ...overrides };
}

describe('command registry dispatch', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false for a command that is not registered', async () => {
    const ctx = makeContext();
    const handled = await dispatch('definitely-not-a-command', [], ctx);
    expect(handled).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('routes /help to the help handler and lists custom commands', async () => {
    const ctx = makeContext({
      customCommandStore: {
        getAllCommands: vi.fn(() => [
          { name: 'deploy', description: 'ship it', source: 'project', argumentHint: '<env>' },
        ]),
      } as unknown as CommandContext['customCommandStore'],
    });

    const handled = await dispatch('help', [], ctx);

    expect(handled).toBe(true);
    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('Available commands:');
    expect(output).toContain('/deploy');
  });

  it('routes /config to openConfigEditor', async () => {
    const openConfigEditor = vi.fn();
    const ctx = makeContext({ openConfigEditor });

    const handled = await dispatch('config', [], ctx);

    expect(handled).toBe(true);
    expect(openConfigEditor).toHaveBeenCalledTimes(1);
  });

  it('routes /api-info through the config store', async () => {
    const get = vi.fn(async () => ({ apiConfig: undefined }));
    const ctx = makeContext({
      configStore: { get } as unknown as CommandContext['configStore'],
    });

    const handled = await dispatch('api-info', [], ctx);

    expect(handled).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('API Configuration:');
  });

  it('routes /trusted and reports when no tools are trusted', async () => {
    const ctx = makeContext({
      permissionManager: {
        getTrustedTools: vi.fn(() => []),
      } as unknown as CommandContext['permissionManager'],
    });

    const handled = await dispatch('trusted', [], ctx);

    expect(handled).toBe(true);
    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('Trusted Tools:');
    expect(output).toContain('(none)');
  });

  it('routes /trusted and lists trusted tools when present', async () => {
    const ctx = makeContext({
      permissionManager: {
        getTrustedTools: vi.fn(() => ['bash', 'edit']),
      } as unknown as CommandContext['permissionManager'],
    });

    await dispatch('trusted', [], ctx);

    const output = logSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('- bash');
    expect(output).toContain('- edit');
  });

  it('routes /trusted to a graceful message when the permission manager is absent', async () => {
    const ctx = makeContext({ permissionManager: null });

    const handled = await dispatch('trusted', [], ctx);

    expect(handled).toBe(true);
    expect(logSpy).toHaveBeenCalledWith('Permission manager not initialized');
  });

  it('routes the workflow-view commands to their stores', async () => {
    const ctx = makeContext();

    await expect(dispatch('decisions', [], ctx)).resolves.toBe(true);
    await expect(dispatch('blockers', [], ctx)).resolves.toBe(true);
    await expect(dispatch('review-gates', [], ctx)).resolves.toBe(true);
  });
});

describe('command registry / metadata reconciliation', () => {
  // Guards against the split-catalog drift: dispatch (builtinCommands) and the
  // autocomplete/help metadata (config/commands.ts COMMANDS) are separate lists
  // during the incremental migration, so a command registered for dispatch must
  // still have a metadata entry or it would dispatch with no autocomplete/help.
  it('every registered command (and alias) has a COMMANDS metadata entry', () => {
    const known = new Set<string>();
    for (const cmd of COMMANDS) {
      known.add(cmd.name);
      for (const alias of cmd.aliases ?? []) known.add(alias);
    }

    const registeredNames = builtinCommands.flatMap(handler => [handler.name, ...(handler.aliases ?? [])]);

    const missing = registeredNames.filter(name => !known.has(name));
    expect(missing).toEqual([]);
  });
});
