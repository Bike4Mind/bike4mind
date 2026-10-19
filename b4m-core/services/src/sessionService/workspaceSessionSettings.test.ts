import { describe, it, expect, vi } from 'vitest';
import type { WorkspaceSessionSettingsTable } from '@bike4mind/common';
import { cloneSession } from './clone';
import { forkSession } from './fork';
import { moveSession } from './move';
import { snipSession } from './snip';

// The fixture workspace is unregistered, so a real transition check would refuse to move it.
vi.mock('./surfaceTransition', async importOriginal => ({
  ...(await importOriginal<typeof import('./surfaceTransition')>()),
  assertSurfaceTransition: vi.fn(async (_from: unknown, to: string | null) => to),
}));

const WORKSPACE = 'example-workspace';

const table: WorkspaceSessionSettingsTable = {
  [WORKSPACE]: {
    ownedFields: ['systemPromptText', 'enabledTools', 'disableUserIntegrations', 'temperature', 'maxToolCalls'],
    resolve: async () => ({}),
  },
};

const OWNED_VALUES = {
  systemPromptText: 'Workspace prompt.',
  enabledTools: ['tool_a'],
  disableUserIntegrations: true,
  temperature: 0.2,
  maxToolCalls: 3,
};

const sourceSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-1',
  userId: 'caller-1',
  name: 'Original',
  knowledgeIds: [],
  tags: [],
  surface: WORKSPACE,
  disabledTools: ['tool_z'],
  ...OWNED_VALUES,
  ...overrides,
});

const makeDb = (session: Record<string, unknown>) => ({
  users: { findById: vi.fn().mockResolvedValue({ id: 'caller-1' }) },
  sessions: {
    findByIdAndUserId: vi.fn().mockResolvedValue(session),
    shareable: { findAccessibleById: vi.fn().mockResolvedValue(session) },
    create: vi.fn(async (data: Record<string, unknown>) => ({ id: 'copy-1', ...data })),
    update: vi.fn(async (data: Record<string, unknown>) => ({ ...session, ...data })),
  },
  projects: {},
  fabFiles: {
    shareable: { findAllAccessibleByIds: vi.fn().mockResolvedValue([]) },
    search: vi.fn().mockResolvedValue({ data: [] }),
    findAccessibleInIds: vi.fn().mockResolvedValue([]),
  },
  chatHistories: {
    findBySessionIdAndId: vi.fn().mockResolvedValue({ id: 'm1', timestamp: new Date(10) }),
    findAllBySessionIdAndLessThanOrEqualToTimestamp: vi.fn().mockResolvedValue([]),
    findAllBySessionIdAndGreaterThanOrEqualToTimestamp: vi.fn().mockResolvedValue([]),
    findAllBySessionId: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  },
});

const createdCopy = (db: ReturnType<typeof makeDb>) => db.sessions.create.mock.calls[0][0] as Record<string, unknown>;

const copies = {
  fork: (db: ReturnType<typeof makeDb>, settings?: WorkspaceSessionSettingsTable) =>
    forkSession(
      'caller-1',
      { sessionId: 'session-1', messageId: 'm1' },
      { db: db as any, workspaceSessionSettings: settings }
    ),
  snip: (db: ReturnType<typeof makeDb>, settings?: WorkspaceSessionSettingsTable) =>
    snipSession(
      'caller-1',
      { sessionId: 'session-1', messageId: 'm1' },
      { db: db as any, workspaceSessionSettings: settings }
    ),
  clone: (db: ReturnType<typeof makeDb>, settings?: WorkspaceSessionSettingsTable) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal adapter shape for this unit test
    cloneSession('caller-1', { id: 'session-1' }, { db: db as any, workspaceSessionSettings: settings }),
};

describe.each(Object.entries(copies))('%s with contributed workspace session settings', (_name, copy) => {
  it('drops the fields the source workspace owns and keeps the rest', async () => {
    const db = makeDb(sourceSession());

    await copy(db, table);

    const created = createdCopy(db);
    for (const field of Object.keys(OWNED_VALUES)) expect(created[field]).toBeUndefined();
    expect(created.surface).toBe(WORKSPACE);
    expect(created.disabledTools).toEqual(['tool_z']);
  });

  it('keeps an owned field the user set explicitly', async () => {
    const db = makeDb(sourceSession({ userSetFields: ['temperature'] }));

    await copy(db, table);

    expect(createdCopy(db)).toEqual(expect.objectContaining({ temperature: 0.2 }));
    expect(createdCopy(db).systemPromptText).toBeUndefined();
  });

  it('copies everything when no table is threaded', async () => {
    const db = makeDb(sourceSession());

    await copy(db);

    expect(createdCopy(db)).toEqual(expect.objectContaining({ temperature: 0.2, enabledTools: ['tool_a'] }));
  });

  it('copies everything from a session outside any contributing workspace', async () => {
    const db = makeDb(sourceSession({ surface: undefined }));

    await copy(db, table);

    expect(createdCopy(db)).toEqual(expect.objectContaining({ temperature: 0.2, enabledTools: ['tool_a'] }));
  });
});

describe('cloneSession by a share holder with contributed workspace session settings', () => {
  it('drops every owned field, including ones the owner set explicitly', async () => {
    const db = makeDb(sourceSession({ userId: 'owner-1', userSetFields: ['temperature', 'maxToolCalls'] }));

    await copies.clone(db, table);

    const created = createdCopy(db);
    for (const field of Object.keys(OWNED_VALUES)) expect(created[field]).toBeUndefined();
  });
});

describe('moveSession with contributed workspace session settings', () => {
  const move = (session: Record<string, unknown>, targetSurface: string | null) => {
    const db = makeDb(session);

    const result = moveSession(
      'caller-1',
      { id: 'session-1', targetSurface },
      { db: db as any, workspaceSessionSettings: table }
    );
    return { db, result };
  };

  it('unsets the owned fields with surface when leaving the workspace for the main list', async () => {
    const { db, result } = move(sourceSession(), null);
    await result;

    expect(db.sessions.update).toHaveBeenCalledWith(
      { id: 'session-1' },
      { unset: ['surface', ...Object.keys(OWNED_VALUES)] }
    );
  });

  it('unsets the owned fields when leaving the workspace for another one', async () => {
    const { db, result } = move(sourceSession(), 'other-workspace');
    await result;

    expect(db.sessions.update).toHaveBeenCalledWith(
      { id: 'session-1', surface: 'other-workspace' },
      { unset: Object.keys(OWNED_VALUES) }
    );
  });

  it('keeps an owned field the user set explicitly', async () => {
    const { db, result } = move(sourceSession({ userSetFields: ['temperature'] }), null);
    await result;

    expect(db.sessions.update.mock.calls[0][1].unset).not.toContain('temperature');
  });

  it('sets no owned field when entering the workspace', async () => {
    const { db, result } = move(sourceSession({ surface: undefined }), WORKSPACE);
    await result;

    expect(db.sessions.update).toHaveBeenCalledWith({ id: 'session-1', surface: WORKSPACE });
  });
});
