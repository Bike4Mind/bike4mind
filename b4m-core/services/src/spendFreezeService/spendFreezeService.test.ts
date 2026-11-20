import { describe, expect, it, vi } from 'vitest';
import type { AuditActor, ISpendFreeze, ISpendFreezeRepository, StoredAuditContext } from '@bike4mind/common';
import { isSpendFrozenError } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { assertSpendNotFrozen, freezeSpend, unfreezeSpend, type SpendFreezeAdapters } from './index';

const scope = { scopeType: 'User', scopeId: 'u1' } as const;
const actor = { kind: 'admin', userId: 'a1' } as const;
const auditActor: AuditActor = { kind: 'user', scope: 'platform', userId: 'a1', name: 'Admin', wasAdmin: true };
const context: StoredAuditContext = { source: 'admin_ui' };
const audit = { actor: auditActor, context };

const makeFreeze = (overrides: Partial<ISpendFreeze> = {}): ISpendFreeze => ({
  id: 'f1',
  ...scope,
  reason: 'r',
  actor,
  frozenAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const setup = () => {
  const spendFreezes = {
    findActive: vi.fn<ISpendFreezeRepository['findActive']>(async () => null),
    findActiveForSubject: vi.fn<ISpendFreezeRepository['findActiveForSubject']>(async () => null),
    createActive: vi.fn<ISpendFreezeRepository['createActive']>(async () => makeFreeze()),
    liftActive: vi.fn<ISpendFreezeRepository['liftActive']>(async () => makeFreeze()),
    listActive: vi.fn<ISpendFreezeRepository['listActive']>(),
    listHistory: vi.fn<ISpendFreezeRepository['listHistory']>(),
  };
  const append = vi.fn(async () => ({}) as never);
  const adapters = {
    db: { spendFreezes, adminAuditLog: { append } },
    logger: { error: vi.fn() },
  } as unknown as SpendFreezeAdapters;
  return { spendFreezes, append, adapters };
};

const input = { scope, actor, reason: ' too much ', audit };

/** Backs the mocked repository with one active slot, so create/lift/find agree like the real one. */
const statefulFreezes = (spendFreezes: ReturnType<typeof setup>['spendFreezes']) => {
  const state: { active: ISpendFreeze | null } = { active: null };
  spendFreezes.findActive.mockImplementation(async () => state.active);
  spendFreezes.createActive.mockImplementation(async freezeInput => {
    if (state.active) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    state.active = makeFreeze({ ...freezeInput, id: `f${spendFreezes.createActive.mock.calls.length}` });
    return state.active;
  });
  spendFreezes.liftActive.mockImplementation(async () => {
    const lifted = state.active;
    state.active = null;
    return lifted;
  });
  return state;
};

describe('freezeSpend', () => {
  it('creates a freeze and audits once', async () => {
    const { spendFreezes, append, adapters } = setup();
    const result = await freezeSpend(input, adapters);
    expect(result.created).toBe(true);
    expect(spendFreezes.createActive).toHaveBeenCalledWith(expect.objectContaining({ ...scope, reason: 'too much' }), {
      session: undefined,
    });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'spend.freeze.applied',
        target: expect.objectContaining({ kind: 'user', id: 'u1' }),
        changes: [{ field: 'spendFrozen', before: false, after: true }],
        details: { freezeId: 'f1', actorKind: 'admin' },
      })
    );
  });

  it('maps scope types to audit target kinds', async () => {
    const { append, adapters } = setup();
    await freezeSpend({ ...input, scope: { scopeType: 'Organization', scopeId: 'o1' } }, adapters);
    await freezeSpend({ ...input, scope: { scopeType: 'apiKey', scopeId: 'k1' } }, adapters);
    const kinds = (append.mock.calls as unknown as Array<[{ target: { kind: string } }]>).map(([e]) => e.target.kind);
    expect(kinds).toEqual(['organization', 'apiKey']);
  });

  it('returns the existing freeze without auditing', async () => {
    const { spendFreezes, append, adapters } = setup();
    spendFreezes.findActive.mockResolvedValue(makeFreeze({ id: 'existing' }));
    const result = await freezeSpend(input, adapters);
    expect(result).toEqual({ freeze: expect.objectContaining({ id: 'existing' }), created: false });
    expect(spendFreezes.createActive).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('returns the committed winner on a duplicate-key race outside a transaction', async () => {
    const { spendFreezes, append, adapters } = setup();
    const fake = statefulFreezes(spendFreezes);
    spendFreezes.createActive.mockImplementationOnce(async () => {
      fake.active = makeFreeze({ id: 'winner' });
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    });
    const result = await freezeSpend(input, adapters);
    expect(result).toEqual({ freeze: expect.objectContaining({ id: 'winner' }), created: false });
    expect(append).not.toHaveBeenCalled();
  });

  it('propagates the re-read error on a race inside an aborted transaction so the retry carries it', async () => {
    const { spendFreezes, append, adapters } = setup();
    const transient = Object.assign(new Error('NoSuchTransaction'), {
      errorLabels: ['TransientTransactionError'],
    });
    spendFreezes.findActive.mockResolvedValueOnce(null).mockRejectedValueOnce(transient);
    spendFreezes.createActive.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    await expect(freezeSpend(input, adapters)).rejects.toBe(transient);
    expect(append).not.toHaveBeenCalled();
  });

  it('rethrows the duplicate-key error when the re-read finds no winner', async () => {
    const { spendFreezes, adapters } = setup();
    const duplicate = Object.assign(new Error('dup'), { code: 11000 });
    spendFreezes.createActive.mockRejectedValue(duplicate);
    await expect(freezeSpend(input, adapters)).rejects.toBe(duplicate);
  });

  it('rethrows non-duplicate create errors', async () => {
    const { spendFreezes, adapters } = setup();
    spendFreezes.createActive.mockRejectedValue(new Error('boom'));
    await expect(freezeSpend(input, adapters)).rejects.toThrow('boom');
  });

  it('refreezes after a lift', async () => {
    const { spendFreezes, append, adapters } = setup();
    statefulFreezes(spendFreezes);
    expect((await freezeSpend(input, adapters)).created).toBe(true);
    expect((await freezeSpend(input, adapters)).created).toBe(false);
    expect((await unfreezeSpend(input, adapters)).lifted).toBe(true);
    const again = await freezeSpend(input, adapters);
    expect(again.created).toBe(true);
    expect(spendFreezes.createActive).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledTimes(3);
  });

  it('rejects an empty reason', async () => {
    const { adapters } = setup();
    await expect(freezeSpend({ ...input, reason: '   ' }, adapters)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects when the strict audit write fails', async () => {
    const { append, adapters } = setup();
    append.mockRejectedValue(new Error('audit down'));
    await expect(freezeSpend(input, adapters)).rejects.toThrow('audit down');
  });
});

describe('unfreezeSpend', () => {
  it('lifts and audits', async () => {
    const { spendFreezes, append, adapters } = setup();
    const now = new Date('2026-02-01T00:00:00Z');
    const result = await unfreezeSpend({ ...input, now }, adapters);
    expect(result.lifted).toBe(true);
    expect(spendFreezes.liftActive).toHaveBeenCalledWith(
      scope,
      { liftedBy: actor, liftReason: 'too much', liftedAt: now },
      { session: undefined }
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'spend.freeze.lifted',
        changes: [{ field: 'spendFrozen', before: true, after: false }],
      })
    );
  });

  it('is a no-op when nothing is active', async () => {
    const { spendFreezes, append, adapters } = setup();
    spendFreezes.liftActive.mockResolvedValue(null);
    expect(await unfreezeSpend(input, adapters)).toEqual({ freeze: null, lifted: false });
    expect(append).not.toHaveBeenCalled();
  });

  it('rejects an empty reason', async () => {
    const { adapters } = setup();
    await expect(unfreezeSpend({ ...input, reason: '' }, adapters)).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects when the strict audit write fails', async () => {
    const { append, adapters } = setup();
    append.mockRejectedValue(new Error('audit down'));
    await expect(unfreezeSpend(input, adapters)).rejects.toThrow('audit down');
  });
});

describe('assertSpendNotFrozen', () => {
  it('throws spend_frozen with the matching scope', async () => {
    const { spendFreezes } = setup();
    spendFreezes.findActiveForSubject.mockResolvedValue(makeFreeze({ scopeType: 'Organization' }));
    const error = await assertSpendNotFrozen({ organizationId: 'o1' }, { db: { spendFreezes } }).catch(
      (e: unknown) => e
    );
    expect(isSpendFrozenError(error)).toBe(true);
    expect((error as { additionalInfo: { frozenScope: string } }).additionalInfo.frozenScope).toBe('organization');
  });

  it('passes when nothing is frozen', async () => {
    const { spendFreezes } = setup();
    await expect(assertSpendNotFrozen({ userId: 'u1' }, { db: { spendFreezes } })).resolves.toBeUndefined();
  });

  it('propagates repository errors', async () => {
    const { spendFreezes } = setup();
    spendFreezes.findActiveForSubject.mockRejectedValue(new Error('db down'));
    await expect(assertSpendNotFrozen({ userId: 'u1' }, { db: { spendFreezes } })).rejects.toThrow('db down');
  });
});
