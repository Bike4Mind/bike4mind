// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { makeChain } from '../../../pages/api/tutorials/__tests__/chain';

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withTransaction: async (fn: (session: unknown) => unknown) => fn({}),
}));

import { tutorialContent } from '../effectiveModules';
import { knownSelectorsOf } from '../validate';
import { overridesRoute } from '../routes';
import { FIXTURE_CONTENT, FIXTURE_POLICY } from './fixture';

type Row = Record<string, unknown> & { moduleId: string; contentSeq?: number; revision: number };
type Update = {
  $set?: Record<string, unknown>;
  $inc?: Record<string, number>;
  $max?: Record<string, number>;
};

function setup() {
  const rows: Row[] = [];
  const Override = {
    find: () => ({ lean: async () => rows.map(row => ({ ...row })) }),
    findOneAndUpdate: async (
      filter: { moduleId: string; contentSeq?: unknown; enabled?: boolean | null },
      update: Update,
      opts: object
    ) => {
      const seq = filter.contentSeq;
      const hit = rows.find(
        row =>
          row.moduleId === filter.moduleId &&
          (typeof seq === 'number' ? row.contentSeq === seq : false) &&
          (!('enabled' in filter) || (row.enabled ?? null) === filter.enabled)
      );
      const row =
        hit ??
        (typeof seq === 'object' && (opts as { upsert?: boolean }).upsert
          ? rows[rows.push({ moduleId: filter.moduleId, revision: 0 }) - 1]
          : undefined);
      if (!row) return null;
      Object.assign(row, update.$set);
      for (const [k, n] of Object.entries(update.$inc ?? {})) row[k] = ((row[k] as number | undefined) ?? 0) + n;
      return { ...row };
    },
  };
  const models = { Override, OverrideChange: { aggregate: async () => [], create: async () => [] } };
  const repo = [FIXTURE_CONTENT];
  const known = knownSelectorsOf(repo);
  const content = tutorialContent({
    models: models as never,
    repo,
    policy: FIXTURE_POLICY,
    validator: { known },
  });
  const route = overridesRoute({
    api: (() => makeChain()) as never,
    isAdmin: () => true,
    models: models as never,
    content,
    repo,
    policy: FIXTURE_POLICY,
    known,
  });
  const put = async (body: unknown) => {
    const { req, res } = createMocks({ method: 'PUT', body: body as object });
    Object.assign(req, { user: { id: 'a1', isAdmin: true }, logger: { info: vi.fn(), warn: vi.fn() } });
    await (route as unknown as (a: unknown, b: unknown) => Promise<void>)(req, res);
    return res;
  };
  return { rows, put };
}

describe('overridesRoute PUT content sequence', () => {
  it('leaves contentSeq alone on a switch toggle, so an open editor still saves', async () => {
    const { rows, put } = setup();
    expect((await put({ moduleId: 'fixture', enabled: false, reason: 'off' })).statusCode).toBe(200);
    expect(rows[0].contentSeq ?? 0).toBe(0);
    const open = FIXTURE_CONTENT.steps.find(s => s.id === 'open')!;
    const fields = [{ kind: 'copy', stepId: 'open', field: 'body', value: 'Changed.', repoValue: open.body }];
    const saved = await put({ moduleId: 'fixture', fields, reason: 'edit', expectedContentSeq: 0 });
    expect(saved.statusCode).toBe(200);
    expect(rows[0].contentSeq).toBe(1);
  });

  it('refuses the second of two switch-only writes made from the same prior', async () => {
    const { rows, put } = setup();
    expect((await put({ moduleId: 'fixture', enabled: true, reason: 'seed' })).statusCode).toBe(200);
    const [first, second] = await Promise.all([
      put({ moduleId: 'fixture', enabled: false, reason: 'off' }),
      put({ moduleId: 'fixture', enabled: false, reason: 'off too' }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    expect(rows[0].enabled).toBe(false);
  });
});
