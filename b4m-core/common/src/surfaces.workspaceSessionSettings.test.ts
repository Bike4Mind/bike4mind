import { describe, it, expect, vi } from 'vitest';
import {
  applyWorkspaceSessionSettings,
  defineWorkspaceSessionSettingsTable,
  respondFromWorkspace,
  workspaceAnswersTurns,
  stripSurfaceOwnedFields,
  surfaceOwnedFields,
  userSetSessionFields,
  type WorkspaceSessionSettingsEntry,
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
  it('returns the session untouched with an empty table', async () => {
    const input = session();

    expect(await applyWorkspaceSessionSettings(input, { user: null }, {})).toBe(input);
  });

  it('keeps a live document virtuals by flattening it before applying owned fields', async () => {
    const table: WorkspaceSessionSettingsTable = {
      [WORKSPACE]: { ownedFields: ['temperature'], resolve: async () => ({ temperature: 0.2 }) },
    };
    const stored = session({ surface: WORKSPACE });
    const live = { ...stored, toJSON: () => ({ ...stored, id: 'virtual-id' }) };

    const effective = await applyWorkspaceSessionSettings(live, { user: null }, table);

    expect(effective).toMatchObject({ id: 'virtual-id', temperature: 0.2 });
  });

  // Fail closed: a missing table must not read as "nothing owned", which would skip the resolver.
  it.each([undefined, null])('throws when the table is %s, even off any workspace', async table => {
    const run = (surface: string | undefined) =>
      applyWorkspaceSessionSettings(session({ surface }), { user: null }, table as never);

    await expect(run(WORKSPACE)).rejects.toThrow('table is required');
    await expect(run(undefined)).rejects.toThrow('table is required');
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

  it('decides owned fields the user set explicitly while the session is on the workspace', async () => {
    const { table } = makeTable({ systemPromptText: 'workspace prompt', temperature: 0.1 });

    const effective = await applyWorkspaceSessionSettings(
      session({ userSetFields: ['temperature', 'enabledTools'] }),
      { user: null },
      table
    );

    expect(effective.temperature).toBe(0.1);
    expect(effective.systemPromptText).toBe('workspace prompt');
    expect('enabledTools' in effective).toBe(false);
  });

  it('restores the user value once a session moved onto the workspace moves back off', async () => {
    const { table } = makeTable({ temperature: 0.1, enabledTools: ['tool_narrow'] });
    const mine = { id: 's1', temperature: 0.9, enabledTools: ['tool_a', 'tool_b'] };
    const userSetFields = userSetSessionFields(mine, table);
    const onWorkspace = { ...mine, surface: WORKSPACE, userSetFields };

    const there = await applyWorkspaceSessionSettings(onWorkspace, { user: null }, table);
    expect(there.temperature).toBe(0.1);
    expect(there.enabledTools).toEqual(['tool_narrow']);

    expect(surfaceOwnedFields(onWorkspace, table)).toEqual(['systemPromptText']);
    const back = { ...onWorkspace, surface: undefined };
    expect(await applyWorkspaceSessionSettings(back, { user: null }, table)).toBe(back);
    expect(back.temperature).toBe(0.9);
    expect(back.enabledTools).toEqual(['tool_a', 'tool_b']);
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

  it.each([undefined, null])('throws rather than keeping owned fields when the table is %s', table => {
    expect(() => stripSurfaceOwnedFields(session(), table as never)).toThrow('table is required');
    expect(() => surfaceOwnedFields(session(), table as never)).toThrow('table is required');
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

describe('applyWorkspaceSessionSettings with a failing resolver', () => {
  it('rethrows naming the workspace instead of falling back to the stored settings', async () => {
    const cause = new Error('lookup failed');
    const table: WorkspaceSessionSettingsTable = {
      [WORKSPACE]: { ownedFields: ['temperature'], resolve: vi.fn(async () => Promise.reject(cause)) },
    };
    const warn = vi.fn();

    const result = applyWorkspaceSessionSettings(session(), { user: null, logger: { warn } }, table);

    await expect(result).rejects.toThrow(`"${WORKSPACE}"`);
    await expect(result).rejects.toMatchObject({ cause });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(WORKSPACE), cause);
  });
});

describe('respondFromWorkspace', () => {
  const quest = { id: 'q1', prompt: 'hello' };
  const tableWith = (respond?: WorkspaceSessionSettingsEntry['respond']): WorkspaceSessionSettingsTable => ({
    [WORKSPACE]: { ownedFields: ['temperature'], resolve: async () => ({}), respond },
  });

  it('reports which sessions answer their own turns', async () => {
    const respond = async () => null;
    const ctx = (over: Parameters<typeof session>[0] = {}) => ({ user: null, session: session(over) });
    await expect(workspaceAnswersTurns(ctx(), tableWith(respond))).resolves.toBe(true);
    await expect(workspaceAnswersTurns(ctx(), tableWith())).resolves.toBe(false);
    await expect(workspaceAnswersTurns(ctx({ surface: 'other' }), tableWith(respond))).resolves.toBe(false);
  });

  it('asks the workspace per session when it scripts only some of them', async () => {
    const answersTurns = vi.fn(async ({ session: s }: { session: { name?: string } }) => s.name === 'scripted');
    const table: WorkspaceSessionSettingsTable = {
      [WORKSPACE]: { ownedFields: [], resolve: async () => ({}), respond: async () => null, answersTurns },
    };

    await expect(
      workspaceAnswersTurns({ user: null, session: { ...session(), name: 'scripted' } as never }, table)
    ).resolves.toBe(true);
    await expect(workspaceAnswersTurns({ user: null, session: session() }, table)).resolves.toBe(false);
  });

  it('counts a session as scripted when the predicate throws', async () => {
    const cause = new Error('lookup failed');
    const warn = vi.fn();
    const table: WorkspaceSessionSettingsTable = {
      [WORKSPACE]: {
        ownedFields: [],
        resolve: async () => ({}),
        respond: async () => null,
        answersTurns: async () => Promise.reject(cause),
      },
    };

    await expect(workspaceAnswersTurns({ user: null, session: session(), logger: { warn } }, table)).resolves.toBe(
      true
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(WORKSPACE), cause);
  });

  it('returns the workspace reply for a session on it', async () => {
    const respond = vi.fn(async () => ({ replies: ['scripted'] }));

    const reply = await respondFromWorkspace({ user: null, session: session(), quest }, tableWith(respond));

    expect(reply).toEqual({ replies: ['scripted'] });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ quest }));
  });

  it('returns null off the workspace, without a responder, or when the responder declines', async () => {
    const respond = vi.fn(async () => ({ replies: ['scripted'] }));

    expect(
      await respondFromWorkspace({ user: null, session: session({ surface: 'other' }), quest }, tableWith(respond))
    ).toBeNull();
    expect(await respondFromWorkspace({ user: null, session: session(), quest }, tableWith())).toBeNull();
    expect(
      await respondFromWorkspace(
        { user: null, session: session(), quest },
        tableWith(async () => null)
      )
    ).toBeNull();
    expect(respond).not.toHaveBeenCalled();
  });

  it('rethrows naming the workspace when the responder fails', async () => {
    const cause = new Error('script missing');
    const warn = vi.fn();

    const result = respondFromWorkspace(
      { user: null, logger: { warn }, session: session(), quest },
      tableWith(async () => Promise.reject(cause))
    );

    await expect(result).rejects.toThrow(`"${WORKSPACE}"`);
    await expect(result).rejects.toMatchObject({ cause });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(WORKSPACE), cause);
  });

  it('refuses a reply with no slots', async () => {
    await expect(
      respondFromWorkspace(
        { user: null, session: session(), quest },
        tableWith(async () => ({ replies: [] }))
      )
    ).rejects.toThrow('returned no replies');
  });
});

describe('userSetSessionFields', () => {
  const { table } = makeTable();

  it('records every owned field a session off any workspace sets', () => {
    expect(userSetSessionFields(session({ surface: undefined }), table)).toEqual([
      'systemPromptText',
      'enabledTools',
      'temperature',
      'maxToolCalls',
    ]);
  });

  it('records only the fields the workspace does not own, plus carried ones it still sets', () => {
    expect(userSetSessionFields(session(), table)).toEqual(['maxToolCalls']);
    expect(userSetSessionFields(session(), table, ['temperature', 'disableUserIntegrations'])).toEqual([
      'temperature',
      'maxToolCalls',
    ]);
  });

  it('records only carried fields on a workspace when no table is given', () => {
    expect(userSetSessionFields(session(), undefined, ['temperature'])).toEqual(['temperature']);
  });
});

describe('defineWorkspaceSessionSettingsTable', () => {
  const resolve = async () => ({});

  it('returns a well-formed table', () => {
    const entries = { [WORKSPACE]: { ownedFields: ['temperature'], resolve } };

    expect(defineWorkspaceSessionSettingsTable(entries)).toBe(entries);
  });

  it.each([
    ['missing ownedFields', { resolve }],
    ['an unknown owned field', { ownedFields: ['temperature', 'name'], resolve }],
    ['a non-array ownedFields', { ownedFields: 'temperature', resolve }],
    ['a missing resolve', { ownedFields: ['temperature'] }],
    ['a non-function resolve', { ownedFields: ['temperature'], resolve: {} }],
    ['a non-function respond', { ownedFields: ['temperature'], resolve, respond: 'reply' }],
    ['a non-function answersTurns', { ownedFields: [], resolve, respond: resolve, answersTurns: true }],
    ['an answersTurns without respond', { ownedFields: [], resolve, answersTurns: async () => true }],
    ['an undefined entry', undefined],
  ])('throws at load for %s', (_label, entry) => {
    expect(() => defineWorkspaceSessionSettingsTable({ [WORKSPACE]: entry })).toThrow(`"${WORKSPACE}"`);
  });
});
