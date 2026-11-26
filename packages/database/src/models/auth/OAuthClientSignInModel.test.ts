import { afterEach, describe, it, expect, vi } from 'vitest';
import { oauthClientSignInRepository, OAuthClientSignInModel } from './OAuthClientSignInModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();
afterEach(() => {
  vi.restoreAllMocks();
});

const at = (iso: string) => new Date(iso);

describe('OAuthClientSignIn repository', () => {
  it('creates the row on the first sign-in, then only moves lastSignInAt forward', async () => {
    await oauthClientSignInRepository.recordSignIn({ userId: 'u1', clientId: 'c1', at: at('2026-01-01T00:00:00Z') });
    const [created] = await oauthClientSignInRepository.listByUser('u1');
    expect(created).toMatchObject({
      clientId: 'c1',
      firstSignInAt: at('2026-01-01T00:00:00Z'),
      lastSignInAt: at('2026-01-01T00:00:00Z'),
    });

    await oauthClientSignInRepository.recordSignIn({ userId: 'u1', clientId: 'c1', at: at('2026-02-01T00:00:00Z') });
    const rows = await oauthClientSignInRepository.listByUser('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.id);
    expect(rows[0].firstSignInAt).toEqual(at('2026-01-01T00:00:00Z'));
    expect(rows[0].lastSignInAt).toEqual(at('2026-02-01T00:00:00Z'));
  });

  it('an out-of-order older write neither regresses lastSignInAt nor advances firstSignInAt', async () => {
    const pair = { userId: 'u2', clientId: 'c2' };
    await oauthClientSignInRepository.recordSignIn({ ...pair, at: at('2026-03-01T00:00:00Z') });
    await oauthClientSignInRepository.recordSignIn({ ...pair, at: at('2026-02-01T00:00:00Z') });
    const [row] = await oauthClientSignInRepository.listByUser('u2');
    expect(row.firstSignInAt).toEqual(at('2026-02-01T00:00:00Z'));
    expect(row.lastSignInAt).toEqual(at('2026-03-01T00:00:00Z'));
  });

  it('folds concurrent first sign-ins into one row', async () => {
    // setupMongoTest drops the indexes before each test; the unique one is what makes the race retry.
    await OAuthClientSignInModel.ensureIndexes();
    const pair = { userId: 'u3', clientId: 'c3' };
    const times = ['2026-04-01', '2026-04-03', '2026-04-02', '2026-04-04'].map(day => at(`${day}T00:00:00Z`));
    await Promise.all(times.map(time => oauthClientSignInRepository.recordSignIn({ ...pair, at: time })));
    const rows = await OAuthClientSignInModel.find(pair).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].firstSignInAt).toEqual(at('2026-04-01T00:00:00Z'));
    expect(rows[0].lastSignInAt).toEqual(at('2026-04-04T00:00:00Z'));
  });

  it('retries a duplicate-key insert once as an update', async () => {
    const pair = { userId: 'u4', clientId: 'c4' };
    await oauthClientSignInRepository.recordSignIn({ ...pair, at: at('2026-05-01T00:00:00Z') });
    const updateOne = vi.spyOn(OAuthClientSignInModel, 'updateOne');
    updateOne.mockImplementationOnce(() => {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    });
    await oauthClientSignInRepository.recordSignIn({ ...pair, at: at('2026-05-02T00:00:00Z') });
    expect(updateOne).toHaveBeenCalledTimes(2);
    const [row] = await oauthClientSignInRepository.listByUser('u4');
    expect(row.lastSignInAt).toEqual(at('2026-05-02T00:00:00Z'));
  });

  it('rethrows any other write error without retrying', async () => {
    const updateOne = vi.spyOn(OAuthClientSignInModel, 'updateOne').mockImplementationOnce(() => {
      throw new Error('connection reset');
    });
    await expect(
      oauthClientSignInRepository.recordSignIn({ userId: 'u5', clientId: 'c5', at: at('2026-05-01T00:00:00Z') })
    ).rejects.toThrow('connection reset');
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(await oauthClientSignInRepository.listByUser('u5')).toEqual([]);
  });

  it('lists a user rows most recent sign-in first, and only theirs', async () => {
    await oauthClientSignInRepository.recordSignIn({ userId: 'u6', clientId: 'old', at: at('2026-01-01T00:00:00Z') });
    await oauthClientSignInRepository.recordSignIn({ userId: 'u6', clientId: 'new', at: at('2026-06-01T00:00:00Z') });
    await oauthClientSignInRepository.recordSignIn({
      userId: 'other',
      clientId: 'new',
      at: at('2026-07-01T00:00:00Z'),
    });
    const rows = await oauthClientSignInRepository.listByUser('u6');
    expect(rows.map(row => row.clientId)).toEqual(['new', 'old']);
  });

  it('deleteAllForUser removes only that user rows and returns the count', async () => {
    await oauthClientSignInRepository.recordSignIn({ userId: 'gone', clientId: 'a', at: at('2026-01-01T00:00:00Z') });
    await oauthClientSignInRepository.recordSignIn({ userId: 'gone', clientId: 'b', at: at('2026-01-01T00:00:00Z') });
    await oauthClientSignInRepository.recordSignIn({ userId: 'kept', clientId: 'a', at: at('2026-01-01T00:00:00Z') });
    expect(await oauthClientSignInRepository.deleteAllForUser('gone')).toBe(2);
    expect(await oauthClientSignInRepository.listByUser('gone')).toEqual([]);
    expect(await oauthClientSignInRepository.listByUser('kept')).toHaveLength(1);
  });
});
