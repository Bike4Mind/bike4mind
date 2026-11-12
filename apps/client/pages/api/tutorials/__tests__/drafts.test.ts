// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError, getWorkspaceSurface, OPTI_SURFACE } from '@bike4mind/common';

type Row = Record<string, unknown> & { moduleId: string; contentSeq: number };

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  session: null as Record<string, unknown> | null,
  quests: [] as Record<string, unknown>[],
  changes: [] as Record<string, unknown>[],
  beforeWrite: null as (() => void) | null,
}));

vi.mock('@server/middlewares/adminApi', async () => {
  const { makeChain } = await import('./chain');
  return { adminApi: (config?: unknown) => makeChain(config) };
});
vi.mock('@server/tutorials/registry', () => ({
  CORE_TUTORIALS: [{ id: 'shipped', title: 'Shipped', visibility: { public: true }, enabled: true }],
  resolveCoreTutorial: (id: string) => (id === 'shipped' ? { id } : null),
}));
vi.mock('@server/tutorials/content', () => ({ CORE_TUTORIAL_CONTENT: [] }));
vi.mock('@server/tutorials/models', async importOriginal => {
  const matches = (row: Record<string, unknown>, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([k, v]) => row[k] === v);
  const lean = <T>(value: T) => ({ lean: async () => value, sort: () => ({ lean: async () => value }) });
  const Draft = {
    find: (filter: Record<string, unknown>) => lean(state.rows.filter(r => matches(r, filter))),
    findOne: (filter: Record<string, unknown>) => lean(state.rows.find(r => matches(r, filter)) ?? null),
    create: async ([doc]: Record<string, unknown>[]) => {
      if (state.rows.some(r => r.moduleId === doc.moduleId)) throw Object.assign(new Error('dup'), { code: 11000 });
      state.rows.push({ ...doc });
    },
    deleteOne: async (filter: Record<string, unknown>) => {
      state.beforeWrite?.();
      const before = state.rows.length;
      state.rows = state.rows.filter(r => !matches(r, filter));
      return { deletedCount: before - state.rows.length };
    },
    findOneAndUpdate: async (
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown>; $inc?: Record<string, number> }
    ) => {
      state.beforeWrite?.();
      const row = state.rows.find(r => matches(r, filter));
      if (!row) return null;
      Object.assign(row, update.$set);
      for (const key of Object.keys(update.$unset ?? {})) delete row[key];
      for (const [key, by] of Object.entries(update.$inc ?? {})) row[key] = (row[key] as number) + by;
      return row;
    },
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    tutorialModels: () => ({
      Progress: {},
      Override: {},
      Draft,
      OverrideChange: {
        create: async (docs: Record<string, unknown>[]) => state.changes.push(...docs),
        aggregate: async () => [],
      },
    }),
  };
});
vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withTransaction: async (fn: (session: unknown) => unknown) => fn({}),
  sessionRepository: { findByIdAndUserId: async () => state.session },
  questRepository: { findAllBySessionId: async () => state.quests },
}));

import drafts from '../drafts';

type Route = (req: unknown, res: unknown) => Promise<void>;
const FULL = { id: 'a1', isAdmin: true };
const DELEGATED = { id: 'd1', isAdmin: false, adminPermissions: ['settings:manage'] };
const KEY = 'meetings:pro';
const OTHER_SURFACE_TOOL = `${getWorkspaceSurface(OPTI_SURFACE)?.toolNamePrefix}schedule`;

const call = async (method: 'GET' | 'POST', body?: unknown, user: Record<string, unknown> = FULL) => {
  const { req, res } = createMocks({ method, body: body as Record<string, unknown> });
  Object.assign(req, { user, logger: { info: vi.fn(), warn: vi.fn() } });
  const outcome = await (drafts as unknown as Route)(req, res).then(
    () => null,
    (e: unknown) => e
  );
  return { status: res._getStatusCode(), json: res._getData() ? res._getJSONData() : undefined, outcome };
};

const done = (id: string, prompt: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: 'done',
  prompt,
  replies: [`answer to ${prompt}`],
  createdAt: `2026-01-01T00:00:0${id.slice(1)}Z`,
  ...extra,
});
const QUESTS = [done('q1', 'first'), done('q2', 'second', { fabFileIds: ['f'] })];
const capture = (patch: Record<string, unknown> = {}) => ({
  action: 'capture',
  sessionId: 's1',
  moduleId: 'my-draft',
  title: 'My draft',
  visibility: { entitlement: KEY },
  ...patch,
});
const rowOf = (id = 'my-draft') => state.rows.find(r => r.moduleId === id) as Row;
const act = (action: string, patch: Record<string, unknown> = {}) =>
  call('POST', { action, moduleId: 'my-draft', contentSeq: rowOf().contentSeq, reason: 'r', ...patch });

beforeEach(() => {
  state.rows = [];
  state.changes = [];
  state.beforeWrite = null;
  state.session = { name: 'My chat', users: [], groups: [], isGlobalWrite: false };
  state.quests = QUESTS;
});

describe('/api/tutorials/drafts', () => {
  it('is declared jwtOnly and gated on settings:manage', () => {
    const config = (drafts as unknown as { _config: { auth?: string; adminPermissions?: unknown } })._config;
    expect(config.auth).toBe('jwtOnly');
    expect(config.adminPermissions).toEqual({ GET: 'settings:manage', POST: 'settings:manage' });
  });

  it.each(['GET', 'POST'] as const)('refuses a delegated admin on %s with 403', async method => {
    const { outcome } = await call(method, method === 'POST' ? capture() : undefined, DELEGATED);
    expect(outcome).toBeInstanceOf(ForbiddenError);
    expect(state.rows).toHaveLength(0);
  });

  it('lists no drafts and asks the card for a visibility', async () => {
    const { json } = await call('GET');
    expect(json.drafts).toEqual([]);
    expect(json.choices).toMatchObject({ visibility: true, canvasTabs: [] });
    expect(json.choices.stepTypes).toEqual(['prompt', 'point', 'dismiss', 'attach']);
  });

  describe('capture', () => {
    it('writes a switched-off draft with its visibility and lists it', async () => {
      const { status, json } = await call('POST', capture());
      expect(status).toBe(200);
      expect(rowOf()).toMatchObject({
        enabled: false,
        capturedBy: 'a1',
        visibility: { entitlement: KEY },
        sourceSessionId: 's1',
      });
      expect(json.drafts[0]).toMatchObject({ moduleId: 'my-draft', approved: false, enabled: false });
      expect(state.changes).toHaveLength(1);
    });

    it('returns 400 VISIBILITY_REQUIRED without one, and writes nothing', async () => {
      const { visibility: _omit, ...body } = capture();
      const { status, json } = await call('POST', body);
      expect(status).toBe(400);
      expect(json).toMatchObject({ code: 'VISIBILITY_REQUIRED' });
      expect(state.rows).toHaveLength(0);
    });

    it('refuses a session on another surface with 409 SURFACE', async () => {
      state.session = { ...state.session, surface: OPTI_SURFACE };
      const { status, json } = await call('POST', capture());
      expect(status).toBe(409);
      expect(json).toMatchObject({ code: 'SURFACE' });
      expect(state.rows).toHaveLength(0);
    });

    it('refuses such a session moved to main with 409 SURFACE', async () => {
      state.quests = [
        done('q1', 'first', { structuredReplies: [{ content: [{ type: 'tool_use', name: OTHER_SURFACE_TOOL }] }] }),
        done('q2', 'second'),
      ];
      const { status, json } = await call('POST', capture());
      expect(status).toBe(409);
      expect(json).toMatchObject({ code: 'SURFACE' });
      expect(state.rows).toHaveLength(0);
    });

    it('refuses an unknown entitlement key with 400, and accepts a known key, a lake grant and public', async () => {
      const bad = await call('POST', capture({ visibility: { entitlement: 'not-a-real:key' } }));
      expect(bad.status).toBe(400);
      expect(bad.json.error).toContain('not-a-real:key');
      expect(state.rows).toHaveLength(0);
      expect((await call('POST', capture({ visibility: { public: true } }))).status).toBe(200);
      const lake = capture({ moduleId: 'lake', visibility: { entitlement: 'datalake:my-lake' } });
      expect((await call('POST', lake)).status).toBe(200);
    });

    it('refuses a repeated id with 409 ID_TAKEN', async () => {
      await call('POST', capture());
      expect((await call('POST', capture())).json).toMatchObject({ code: 'ID_TAKEN' });
    });
  });

  describe('save', () => {
    beforeEach(async () => {
      await call('POST', capture());
    });

    it('returns 400 for a null visibility and leaves the row alone', async () => {
      const { status } = await act('save', { visibility: null });
      expect(status).toBe(400);
      expect(rowOf().visibility).toEqual({ entitlement: KEY });
    });

    it('refuses an unknown entitlement key with 400 and leaves the row alone', async () => {
      const before = rowOf().contentSeq;
      const { status } = await act('save', { visibility: { entitlement: 'typo:key' } });
      expect(status).toBe(400);
      expect(rowOf().contentSeq).toBe(before);
    });

    it('a visibility change is a content write: approval cleared, draft switched off', async () => {
      await act('sheet', { name: 'a.csv', csv: 'a,b\n1,2\n' });
      await act('save', { pitch: 'A short pitch.' });
      expect((await act('approve')).status).toBe(200);
      expect((await act('enable', { enabled: true })).status).toBe(200);
      expect(rowOf()).toMatchObject({ enabled: true, approvedSeq: rowOf().contentSeq });
      const { status } = await act('save', { visibility: { public: true } });
      expect(status).toBe(200);
      expect(rowOf()).toMatchObject({ enabled: false, visibility: { public: true } });
      expect(rowOf().approvedSeq).toBeUndefined();
    });

    it('answers a stale contentSeq with 409 STALE', async () => {
      const { status, json } = await act('save', { contentSeq: 1, pitch: 'x' });
      expect(status).toBe(409);
      expect(json).toMatchObject({ code: 'STALE' });
    });

    it('answers STALE from the guarded write when the seq moves after the pre-read', async () => {
      const seq = rowOf().contentSeq;
      state.beforeWrite = () => {
        rowOf().contentSeq = seq + 1;
      };
      const { status, json } = await act('save', { contentSeq: seq, pitch: 'x' });
      expect(status).toBe(409);
      expect(json).toMatchObject({ code: 'STALE' });
      expect(rowOf().pitch).not.toBe('x');
    });

    it('a save that changes nothing leaves the seq, approval and enabled flag alone', async () => {
      await act('sheet', { name: 'a.csv', csv: 'a,b\n1,2\n' });
      await act('save', { pitch: 'A short pitch.' });
      await act('approve');
      await act('enable', { enabled: true });
      const before = JSON.parse(JSON.stringify(rowOf()));
      const audits = state.changes.length;
      const { status } = await act('save', { pitch: 'A short pitch.', title: rowOf().title });
      expect(status).toBe(200);
      expect(rowOf()).toEqual(before);
      expect(state.changes).toHaveLength(audits);
    });

    it('audits only the fields that changed', async () => {
      await act('save', { pitch: 'New pitch.', title: rowOf().title });
      const last = state.changes[state.changes.length - 1];
      expect(JSON.parse(last.after as string)).toEqual({ fields: ['pitch'] });
    });
  });

  describe('approve and enable', () => {
    it('refuses to approve a stored row that lacks a visibility with 422', async () => {
      await call('POST', capture());
      delete rowOf().visibility;
      Object.assign(rowOf(), { pitch: 'A pitch.', sheet: { name: 'a.csv', csv: 'a,b\n1,2\n' } });
      const { status, json } = await act('approve');
      expect(status).toBe(422);
      expect(json.rules.map((r: { rule: string }) => r.rule)).toContain('draft-visibility');
      expect(rowOf().approvedSeq).toBeUndefined();
    });

    it('refuses to switch on an unapproved draft with 422 NOT_APPROVED', async () => {
      await call('POST', capture());
      const { status, json } = await act('enable', { enabled: true });
      expect(status).toBe(422);
      expect(json).toMatchObject({ code: 'NOT_APPROVED' });
    });

    it('deletes a draft and keeps its content in the audit row', async () => {
      await call('POST', capture());
      await act('delete');
      expect(state.rows).toHaveLength(0);
      const last = state.changes[state.changes.length - 1];
      expect(last.field).toBe('draft:delete');
      expect(JSON.parse(last.before as string)).toMatchObject({
        title: 'My draft',
        content: { moduleId: 'my-draft', title: 'My draft' },
      });
    });

    it('refuses a delete carrying a stale contentSeq with 409 STALE and keeps the row', async () => {
      await call('POST', capture());
      const { status, json } = await act('delete', { contentSeq: rowOf().contentSeq - 1 });
      expect(status).toBe(409);
      expect(json).toMatchObject({ code: 'STALE' });
      expect(state.rows).toHaveLength(1);
    });

    it('answers STALE when the seq moves between the pre-read and the guarded delete', async () => {
      await call('POST', capture());
      const seq = rowOf().contentSeq;
      state.beforeWrite = () => {
        rowOf().contentSeq = seq + 1;
      };
      const { status, json } = await act('delete', { contentSeq: seq });
      expect(status).toBe(409);
      expect(json).toMatchObject({ code: 'STALE' });
      expect(state.rows).toHaveLength(1);
    });
  });

  it('rejects a malformed body with 400', async () => {
    expect((await call('POST', { action: 'nope' })).status).toBe(400);
  });
});
