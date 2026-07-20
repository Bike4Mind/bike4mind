/**
 * Accept/reject matrix for the plugin module shape guards. These guards are
 * what keeps a malformed plugin from crashing bootstrap, so every rejected
 * shape here corresponds to a crash that used to be possible.
 */

import { describe, it, expect, vi } from 'vitest';
import { validateFeatureModule, findMalformedTool, makeScopedLogger } from './pluginContract';
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

describe('findMalformedTool', () => {
  const goodTool = { toolFn: () => {}, toolSchema: { name: 'do_thing', description: '', parameters: {} } };

  it('passes a module with well-formed tools', () => {
    expect(findMalformedTool(makeModule({ getTools: () => [goodTool] }))).toBeNull();
  });

  it('passes a module with no tools', () => {
    expect(findMalformedTool(makeModule())).toBeNull();
  });

  it('flags a getTools that throws', () => {
    const module = makeModule({
      getTools: () => {
        throw new Error('boom');
      },
    });
    expect(findMalformedTool(module)).toContain('boom');
  });

  it('flags a non-array return', () => {
    expect(findMalformedTool(makeModule({ getTools: () => 'nope' }))).toContain('array');
  });

  it.each([
    ['missing toolFn', { toolSchema: { name: 'x' } }],
    ['missing toolSchema', { toolFn: () => {} }],
    ['empty schema name', { toolFn: () => {}, toolSchema: { name: '' } }],
    ['null tool', null],
  ])('flags a tool with %s', (_label, tool) => {
    expect(findMalformedTool(makeModule({ getTools: () => [goodTool, tool] }))).toContain('index 1');
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
