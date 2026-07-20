/**
 * Accept/reject matrix for the plugin module shape guards. These guards are
 * what keeps a malformed plugin from crashing bootstrap, so every rejected
 * shape here corresponds to a crash that used to be possible.
 */

import { describe, it, expect, vi } from 'vitest';
import { validateFeatureModule, findModuleProblem, makeScopedLogger } from './pluginContract';
import type { ICliFeatureModule } from './ICliFeatureModule';
import type { Logger } from '../utils/Logger';

function makeModule(overrides: Record<string, unknown> = {}): ICliFeatureModule {
  return {
    name: 'test-plugin',
    description: 'a test plugin',
    getTools: () => [],
    getSystemPromptSection: () => '',
    ...overrides,
  } as unknown as ICliFeatureModule;
}

describe('validateFeatureModule', () => {
  it('accepts a minimal valid module', () => {
    expect(validateFeatureModule(makeModule())).toBe(true);
  });

  it('accepts optional hooks when they are functions', () => {
    expect(
      validateFeatureModule(makeModule({ getCommands: () => [], registerWsHandlers: () => {}, dispose: () => {} }))
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['empty name', makeModule({ name: '' })],
    ['non-string name', makeModule({ name: 42 })],
    ['missing description', makeModule({ description: undefined })],
    ['non-function getTools', makeModule({ getTools: 'nope' })],
    ['missing getSystemPromptSection', makeModule({ getSystemPromptSection: undefined })],
    ['non-function dispose', makeModule({ dispose: 'nope' })],
  ])('rejects %s', (_label, value) => {
    expect(validateFeatureModule(value)).toBe(false);
  });
});

describe('findModuleProblem', () => {
  const goodTool = {
    toolFn: () => {},
    toolSchema: { name: 'do_thing', description: 'does a thing', parameters: { type: 'object', properties: {} } },
  };

  it('passes a well-formed module', () => {
    expect(findModuleProblem(makeModule({ getTools: () => [goodTool] }))).toBeNull();
  });

  it('passes a module with no tools', () => {
    expect(findModuleProblem(makeModule())).toBeNull();
  });

  it('flags a getTools that throws', () => {
    const module = makeModule({
      getTools: () => {
        throw new Error('boom');
      },
    });
    expect(findModuleProblem(module)).toContain('boom');
  });

  it('flags a non-array getTools return', () => {
    expect(findModuleProblem(makeModule({ getTools: () => 'nope' }))).toContain('array');
  });

  it.each([
    ['missing toolFn', { toolSchema: { name: 'x', description: '', parameters: { type: 'object', properties: {} } } }],
    ['missing toolSchema', { toolFn: () => {} }],
    ['null tool', null],
  ])('flags a tool with %s', (_label, tool) => {
    expect(findModuleProblem(makeModule({ getTools: () => [goodTool, tool] }))).toContain('index 1');
  });

  it('flags a tool with an empty schema name', () => {
    const tool = {
      toolFn: () => {},
      toolSchema: { name: '', description: '', parameters: { type: 'object', properties: {} } },
    };
    expect(findModuleProblem(makeModule({ getTools: () => [tool] }))).toContain('name');
  });

  it('flags a tool missing a string description', () => {
    const tool = { toolFn: () => {}, toolSchema: { name: 'x', parameters: { type: 'object', properties: {} } } };
    expect(findModuleProblem(makeModule({ getTools: () => [tool] }))).toContain('description');
  });

  it.each([
    ['empty parameters', {}],
    ['wrong type', { type: 'array', properties: {} }],
    ['missing properties', { type: 'object' }],
  ])('flags a tool with %s', (_label, parameters) => {
    const tool = { toolFn: () => {}, toolSchema: { name: 'x', description: 'd', parameters } };
    expect(findModuleProblem(makeModule({ getTools: () => [tool] }))).toContain('parameters');
  });

  it('flags a getSystemPromptSection that throws', () => {
    const module = makeModule({
      getSystemPromptSection: () => {
        throw new Error('prompt boom');
      },
    });
    expect(findModuleProblem(module)).toContain('prompt boom');
  });

  it('flags a getSystemPromptSection that returns a non-string', () => {
    expect(findModuleProblem(makeModule({ getSystemPromptSection: () => 42 }))).toContain('string');
  });

  it('flags a getCommands that throws', () => {
    const module = makeModule({
      getCommands: () => {
        throw new Error('cmd boom');
      },
    });
    expect(findModuleProblem(module)).toContain('cmd boom');
  });

  it('flags a getCommands that returns a non-array', () => {
    expect(findModuleProblem(makeModule({ getCommands: () => 'nope' }))).toContain('array');
  });
});

describe('makeScopedLogger', () => {
  it('prefixes every level with the plugin name', () => {
    const base = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const scoped = makeScopedLogger(base, 'foo');
    scoped.debug('d');
    scoped.info('i');
    scoped.warn('w');
    scoped.error('e');
    expect(base.debug).toHaveBeenCalledWith('[plugin:foo] d');
    expect(base.info).toHaveBeenCalledWith('[plugin:foo] i');
    expect(base.warn).toHaveBeenCalledWith('[plugin:foo] w');
    expect(base.error).toHaveBeenCalledWith('[plugin:foo] e');
  });
});
