import { describe, it, expect, beforeEach } from 'vitest';
import type { IDataLakeOwnershipOffer } from '@bike4mind/common';
import {
  DataLakeOwnershipOfferModel as OfferModel,
  buildPendingOfferExpiryFilter,
  dataLakeOwnershipOfferRepository as repo,
} from './DataLakeOwnershipOfferModel';
import { setupMongoTest } from '../../__test__/utils';

const offer = (
  overrides: Partial<IDataLakeOwnershipOffer> = {}
): Omit<IDataLakeOwnershipOffer, 'id' | 'createdAt' | 'updatedAt'> => ({
  dataLakeId: 'lake-1',
  offeredByUserId: 'owner',
  recipientUserId: 'alice',
  status: 'pending',
  expiresAt: new Date('2026-10-01T00:00:00Z'),
  priorOwnerUserIds: ['owner'],
  offeredVia: 'creator',
  ...overrides,
});

describe('buildPendingOfferExpiryFilter - the shared live-offer predicate', () => {
  it('is empty when no asOf is given (expired rows are included)', () => {
    expect(buildPendingOfferExpiryFilter()).toEqual({});
  });

  it('admits never-expiring OR not-yet-expired offers at asOf', () => {
    const asOf = new Date('2026-09-01T00:00:00Z');
    expect(buildPendingOfferExpiryFilter(asOf)).toEqual({
      $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: asOf } }],
    });
  });
});

describe('DataLakeOwnershipOfferRepository', () => {
  setupMongoTest();
  // beforeEach() dropDatabase()s (indexes included) and this model is not in setupMongoTest's
  // one-time ensureIndexes list - rebuild per test so the partial unique index is real.
  beforeEach(async () => {
    await OfferModel.ensureIndexes();
  });

  it('allows at most one PENDING offer per lake, but a resolved one does not block the next', async () => {
    const first = await repo.create(offer());
    await expect(OfferModel.create(offer() as unknown as Record<string, unknown>)).rejects.toThrow(
      /duplicate key|E11000/i
    );

    // Resolving the open one frees the slot: the invariant is one LIVE offer, not one ever.
    expect(await repo.resolve(first.id, 'declined')).not.toBeNull();
    const second = await repo.create(offer({ recipientUserId: 'bob' }));
    expect(second.id).toBeDefined();
    expect(await repo.findPendingForLake('lake-1')).not.toBeNull();
  });

  it('resolve is atomic: the second resolve loses and reports it', async () => {
    const created = await repo.create(offer());
    const accepted = await repo.resolve(created.id, 'accepted');
    expect(accepted?.status).toBe('accepted');
    expect(accepted?.resolvedAt).toBeInstanceOf(Date);

    // The row is no longer pending, so the precondition matches nothing - this is the double-accept
    // guard the service leans on rather than read-then-write.
    expect(await repo.resolve(created.id, 'cancelled')).toBeNull();
    // And it did not overwrite the winner's status.
    expect((await repo.findById(created.id))?.status).toBe('accepted');
  });

  it('findPendingForLake filters expired offers at asOf but not without one', async () => {
    await repo.create(offer({ expiresAt: new Date('2026-01-01T00:00:00Z') }));
    const asOf = new Date('2026-06-01T00:00:00Z');
    expect(await repo.findPendingForLake('lake-1', asOf)).toBeNull();
    // Without asOf the lapsed row is still readable RAW - `cancelLakeOwnershipOffer` reads it that way
    // so an offer that expired can still be cancelled. The OFFER path must not rely on this read: it
    // retires the row first (see `expirePendingForLake`), because this raw read still occupies the
    // one-live-offer index.
    expect((await repo.findPendingForLake('lake-1'))?.status).toBe('pending');
  });

  it('expirePendingForLake retires a lapsed row and frees the one-live-offer slot', async () => {
    const lapsed = await repo.create(offer({ expiresAt: new Date('2026-01-01T00:00:00Z') }));
    const asOf = new Date('2026-06-01T00:00:00Z');

    expect(await repo.expirePendingForLake('lake-1', asOf)).toBe(1);

    const retired = await repo.findById(lapsed.id);
    expect(retired?.status).toBe('expired');
    expect(retired?.resolvedAt).toEqual(asOf);
    // A fresh offer now inserts: the partial unique index no longer sees a pending row for the lake.
    const second = await repo.create(offer({ recipientUserId: 'bob' }));
    expect(second.id).toBeDefined();
    expect((await repo.findPendingForLake('lake-1'))?.recipientUserId).toBe('bob');
  });

  it('expirePendingForLake leaves a still-live row alone', async () => {
    await repo.create(offer({ expiresAt: new Date('2026-12-01T00:00:00Z') }));
    expect(await repo.expirePendingForLake('lake-1', new Date('2026-06-01T00:00:00Z'))).toBe(0);
    expect((await repo.findPendingForLake('lake-1'))?.status).toBe('pending');
  });

  it('expirePendingForLake leaves a RESOLVED row past its expiry alone', async () => {
    // The `status: 'pending'` clause keeps an accepted offer's history from being rewritten to
    // `expired` (and its `resolvedAt` overwritten) once the calendar passes its `expiresAt` - which
    // every accepted offer eventually does.
    const accepted = await repo.create(offer({ expiresAt: new Date('2026-01-01T00:00:00Z') }));
    await repo.resolve(accepted.id, 'accepted');
    const asOf = new Date('2026-06-01T00:00:00Z');

    expect(await repo.expirePendingForLake('lake-1', asOf)).toBe(0);

    const after = await repo.findById(accepted.id);
    expect(after?.status).toBe('accepted');
    expect(after?.resolvedAt).not.toEqual(asOf);
  });

  it('expirePendingForLake matches its own lake and the inclusive boundary', async () => {
    const boundary = new Date('2026-06-01T00:00:00Z');
    await repo.create(offer({ dataLakeId: 'lake-1', expiresAt: boundary }));
    const other = await repo.create(offer({ dataLakeId: 'lake-2', expiresAt: new Date('2026-01-01T00:00:00Z') }));

    // `$lte`, mirroring the read filter's `$gt`: a row is retired exactly when the reads stop seeing
    // it. And only THIS lake's rows - another lake's lapsed offer must not be touched.
    expect(await repo.expirePendingForLake('lake-1', boundary)).toBe(1);
    expect((await repo.findById(other.id))?.status).toBe('pending');
  });

  it('listPendingForRecipient returns only that recipient live offers', async () => {
    await repo.create(offer({ recipientUserId: 'alice', dataLakeId: 'lake-1' }));
    await repo.create(offer({ recipientUserId: 'alice', dataLakeId: 'lake-2' }));
    await repo.create(offer({ recipientUserId: 'bob', dataLakeId: 'lake-3' }));
    await repo.create(offer({ recipientUserId: 'alice', dataLakeId: 'lake-4', status: 'declined' }));

    const alice = await repo.listPendingForRecipient('alice');
    expect(alice.map(o => o.dataLakeId).sort()).toEqual(['lake-1', 'lake-2']);
  });
});
