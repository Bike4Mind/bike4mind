/**
 * The registry runs plugin hooks (registerWsHandlers/dispose/command.execute)
 * in bare loops outside any per-plugin guard, so a throwing hook must be
 * isolated here or it crashes bootstrap / hot-reload / exit / dispatch.
 */

import { describe, it, expect, vi } from 'vitest';
import { FeatureModuleRegistry } from './FeatureModuleRegistry';
import type { ICliFeatureModule } from './ICliFeatureModule';
import type { WebSocketConnectionManager } from '../ws/WebSocketConnectionManager';

vi.mock('../utils/Logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mod(name: string, overrides: Partial<ICliFeatureModule> = {}): ICliFeatureModule {
  return {
    name,
    description: '',
    getTools: () => [],
    getSystemPromptSection: () => '',
    ...overrides,
  };
}

const wsManager = {} as WebSocketConnectionManager;

describe('FeatureModuleRegistry fault isolation', () => {
  it('registerAllWsHandlers isolates a throwing module and still runs the others', () => {
    const good = vi.fn();
    const registry = new FeatureModuleRegistry();
    registry.register(
      mod('bad', {
        registerWsHandlers: () => {
          throw new Error('ws boom');
        },
      })
    );
    registry.register(mod('good', { registerWsHandlers: good }));

    expect(() => registry.registerAllWsHandlers(wsManager)).not.toThrow();
    expect(good).toHaveBeenCalledWith(wsManager);
  });

  it('disposeAll isolates a throwing dispose and still disposes the others', () => {
    const good = vi.fn();
    const registry = new FeatureModuleRegistry();
    registry.register(
      mod('bad', {
        dispose: () => {
          throw new Error('dispose boom');
        },
      })
    );
    registry.register(mod('good', { dispose: good }));

    expect(() => registry.disposeAll()).not.toThrow();
    expect(good).toHaveBeenCalled();
  });

  it('getAllTools isolates a module whose getTools throws and keeps the rest', () => {
    const registry = new FeatureModuleRegistry();
    registry.register(
      mod('bad', {
        getTools: () => {
          throw new Error('tools boom');
        },
      })
    );
    registry.register(
      mod('good', {
        getTools: () => [
          {
            toolFn: async () => 'ok',
            toolSchema: { name: 'good_tool', description: 'd', parameters: { type: 'object', properties: {} } },
          },
        ],
      })
    );
    expect(() => registry.getAllTools()).not.toThrow();
    expect(registry.getAllToolNames()).toEqual(['good_tool']);
  });

  it('getSystemPromptSections isolates a throwing module', () => {
    const registry = new FeatureModuleRegistry();
    registry.register(
      mod('bad', {
        getSystemPromptSection: () => {
          throw new Error('prompt boom');
        },
      })
    );
    registry.register(mod('good', { getSystemPromptSection: () => 'good section' }));
    expect(() => registry.getSystemPromptSections()).not.toThrow();
    expect(registry.getSystemPromptSections()).toContain('good section');
  });

  it('getAllCommands isolates a module whose getCommands throws', () => {
    const registry = new FeatureModuleRegistry();
    registry.register(
      mod('bad', {
        getCommands: () => {
          throw new Error('cmds boom');
        },
      })
    );
    registry.register(mod('good', { getCommands: () => [{ name: 'g', description: '', execute: () => {} }] }));
    expect(() => registry.getAllCommands()).not.toThrow();
    expect(registry.getAllCommands().map(c => c.name)).toEqual(['g']);
  });

  it('executeCommand isolates a module whose getCommands throws and still checks the rest', () => {
    const registry = new FeatureModuleRegistry();
    registry.register(
      mod('bad', {
        getCommands: () => {
          throw new Error('getCommands boom');
        },
      })
    );
    registry.register(mod('good', { getCommands: () => [{ name: 'g', description: '', execute: () => {} }] }));
    // The bad module (registered first) must not crash dispatch or shadow 'g'.
    expect(registry.executeCommand('g', [])).toBe(true);
    expect(registry.executeCommand('nope', [])).toBe(false);
  });

  it('executeCommand swallows a throwing command but still reports it handled', () => {
    const registry = new FeatureModuleRegistry();
    registry.register(
      mod('bad', {
        getCommands: () => [
          {
            name: 'boom',
            description: '',
            execute: () => {
              throw new Error('cmd boom');
            },
          },
        ],
      })
    );
    expect(registry.executeCommand('boom', [])).toBe(true);
  });

  it('executeCommand catches a rejecting async command (no unhandled rejection)', async () => {
    const registry = new FeatureModuleRegistry();
    registry.register(
      mod('bad', {
        getCommands: () => [
          // async execute returns a rejecting promise; the dispatch must catch it
          {
            name: 'boom',
            description: '',
            execute: (async () => {
              throw new Error('async boom');
            }) as () => void,
          },
        ],
      })
    );
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRej);
    expect(registry.executeCommand('boom', [])).toBe(true);
    await new Promise(r => setTimeout(r, 30));
    process.off('unhandledRejection', onRej);
    expect(rejections).toHaveLength(0);
  });
});
