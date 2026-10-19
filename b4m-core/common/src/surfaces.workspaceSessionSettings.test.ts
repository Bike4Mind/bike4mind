import { describe, it, expect, vi } from 'vitest';
import {
  applyWorkspaceSessionSettings,
  stripSurfaceOwnedFields,
  surfaceOwnedFields,
  type WorkspaceSessionSettingsTable,
} from './surfaces';

const WORKSPACE = 'example-workspace';

const makeTable = (resolved: Record<string, unknown> = {}) => {
  const resolve = vi.fn(async () => resolved);
  const table: WorkspaceSessionSettingsTable = {
    [WORKSPACE]: { ownedFields: ['systemPromptText', 'temperature', 'enabledTools'], resolve },
  };
  return { table, resolve };
};

const session = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  surface: WORKSPACE,
  systemPromptText: 'baked prompt',
  temperature: 0.9,
  enabledTools: ['tool_old'],
  maxToolCalls: 4,
  ...overrides,
});

describe('applyWorkspaceSessionSettings', () => {
  it('returns the session untouched with no table', async () => {
    const input = session();

    expect(await applyWorkspaceSessionSettings(input, { user: null }, undefined)).toBe(input);
    expect(await applyWorkspaceSessionSettings(input, { user: null }, {})).toBe(input);
  });

  it('overrides owned fields with resolved values and clears owned fields the resolver omits', async () => {
    const { table, resolve } = makeTable({ systemPromptText: 'workspace prompt', temperature: 0.1, maxToolCalls: 99 });
    const user = { id: 'u1' };
    const input = session();

    const effective = await applyWorkspaceSessionSettings(input, { user }, table);

    expect(resolve).toHaveBeenCalledWith({ user, session: input });
    expect(effective.systemPromptText).toBe('workspace prompt');
    expect(effective.temperature).toBe(0.1);
    expect('enabledTools' in effective).toBe(false);
    // Not owned, so the resolver cannot set it.
    expect(effective.maxToolCalls).toBe(4);
    expect(input.systemPromptText).toBe('baked prompt');
  });

  it.each([null, undefined, '', 'other-workspace'])('ignores a session on surface %s', async surface => {
    const { table, resolve } = makeTable({ temperature: 0.1 });
    const input = session({ surface });

    expect(await applyWorkspaceSessionSettings(input, { user: null }, table)).toBe(input);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not resolve an inherited property name as a surface', async () => {
    const { table, resolve } = makeTable({ temperature: 0.1 });

    await applyWorkspaceSessionSettings(session({ surface: 'constructor' }), { user: null }, table);
    await applyWorkspaceSessionSettings(session({ surface: '__proto__' }), { user: null }, table);

    expect(resolve).not.toHaveBeenCalled();
  });

  it('leaves fields the user set explicitly alone', async () => {
    const { table } = makeTable({ systemPromptText: 'workspace prompt', temperature: 0.1 });

    const effective = await applyWorkspaceSessionSettings(
      session({ userSetFields: ['temperature'] }),
      { user: null },
      table
    );

    expect(effective.temperature).toBe(0.9);
    expect(effective.systemPromptText).toBe('workspace prompt');
  });

  it('ignores an owned field outside the ownable set', async () => {
    const table = {
      [WORKSPACE]: { ownedFields: ['name'], resolve: async () => ({ name: 'renamed' }) },
    } as unknown as WorkspaceSessionSettingsTable;
    const input = { ...session(), name: 'kept' };

    expect(await applyWorkspaceSessionSettings(input, { user: null }, table)).toBe(input);
  });
});

describe('stripSurfaceOwnedFields', () => {
  it('drops owned fields and keeps the rest', () => {
    const { table } = makeTable();

    expect(stripSurfaceOwnedFields(session(), table)).toEqual({ id: 's1', surface: WORKSPACE, maxToolCalls: 4 });
  });

  it('keys on the source session when stripping a separately built copy', () => {
    const { table } = makeTable();
    const copy = { surface: 'other-workspace', temperature: 0.9, maxToolCalls: 4 };

    expect(stripSurfaceOwnedFields(copy, table, { surface: WORKSPACE })).toEqual({
      surface: 'other-workspace',
      maxToolCalls: 4,
    });
    expect(stripSurfaceOwnedFields(copy, table)).toBe(copy);
  });

  it('keeps fields the user set explicitly', () => {
    const { table } = makeTable();

    expect(stripSurfaceOwnedFields(session({ userSetFields: ['temperature'] }), table).temperature).toBe(0.9);
  });

  it.each([null, undefined, 'other-workspace'])('returns a session on surface %s unchanged', surface => {
    const { table } = makeTable();
    const input = session({ surface });

    expect(stripSurfaceOwnedFields(input, table)).toBe(input);
  });

  it('returns the session unchanged with no table', () => {
    const input = session();

    expect(stripSurfaceOwnedFields(input, undefined)).toBe(input);
  });
});

describe('surfaceOwnedFields', () => {
  it('lists the owned fields the user has not set', () => {
    const { table } = makeTable();

    expect(surfaceOwnedFields(session({ userSetFields: ['enabledTools'] }), table)).toEqual([
      'systemPromptText',
      'temperature',
    ]);
    expect(surfaceOwnedFields(session({ surface: undefined }), table)).toEqual([]);
  });
});
