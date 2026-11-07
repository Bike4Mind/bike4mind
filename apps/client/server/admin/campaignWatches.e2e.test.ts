import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { Request } from 'express';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { CampaignWatchModel, User, campaignWatchRepository } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: mocks.audit }));
import { campaignWatchDetail, changeCampaignWatch, createCampaignWatch, listCampaignWatches } from './campaignWatches';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const owner = 'a'.repeat(24);
const other = 'b'.repeat(24);
const first = 'c'.repeat(24);
const second = 'd'.repeat(24);
const source = 'e'.repeat(24);
const request = (id = owner) => ({ user: { id, isAdmin: true } }) as Request;
const input = {
  name: 'Investigate account group',
  userIds: [first, second],
  sourceDetectionId: source,
  reason: 'Monitor linked account activity',
};
let database: MongoMemoryReplSet;

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await CampaignWatchModel.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.audit.mockResolvedValue(null);
  await CampaignWatchModel.deleteMany({});
  await User.collection.deleteMany({});
  await User.collection.insertMany(
    [owner, other, first, second].map((id, index) => ({
      _id: new mongoose.Types.ObjectId(id),
      name: `Account ${index}`,
      currentCredits: 1000,
      deletedAt: null,
    }))
  );
});

describe('persistent campaign watches', () => {
  it('keeps fixed membership and access links independent of the source detection or AI advisory', async () => {
    const result = await createCampaignWatch(request(), input);
    expect(result.created).toBe(true);
    const details = await campaignWatchDetail(result.watch.id);
    expect(details.watch.userIds).toEqual([first, second]);
    expect(details.watch.sourceDetectionId).toBe(source);
    expect(details.members.map(member => member.id)).toEqual([first, second]);
    expect(details.ownerName).toBe('Account 0');
    expect(details.watch.lastCheckedAt).toBeNull();
    expect((await listCampaignWatches('open')).items.map(watch => watch.id)).toContain(result.watch.id);
    expect(CampaignWatchModel.schema.indexes().some(([, options]) => 'expireAfterSeconds' in options)).toBe(false);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'security.watch.created', reason: input.reason })
    );
  });

  it('reuses an open watch for the same exact cohort instead of duplicating it', async () => {
    const a = await createCampaignWatch(request(), input);
    const b = await createCampaignWatch(request(other), {
      ...input,
      userIds: [...input.userIds].reverse(),
      name: 'Another name',
    });
    expect(b.created).toBe(false);
    expect(b.watch.id).toBe(a.watch.id);
    expect(b.watch.ownerId).toBe(owner);
    expect(await CampaignWatchModel.countDocuments()).toBe(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it('rejects unavailable accounts and impersonated writes', async () => {
    await expect(createCampaignWatch(request(), { ...input, userIds: ['f'.repeat(24)] })).rejects.toThrow(
      'unavailable'
    );
    await expect(createCampaignWatch({ user: { id: owner, impersonatedBy: other } } as Request, input)).rejects.toThrow(
      'administrator session'
    );
    expect(await CampaignWatchModel.countDocuments()).toBe(0);
  });

  it('rolls back the watch when its required audit write fails', async () => {
    mocks.audit.mockRejectedValue(new Error('audit unavailable'));
    await expect(createCampaignWatch(request(), input)).rejects.toThrow('audit unavailable');
    expect(await CampaignWatchModel.countDocuments()).toBe(0);
  });

  it('records explicit checks, ownership and close/reopen transitions with revision guards', async () => {
    const { watch } = await createCampaignWatch(request(), input);
    const claimed = await changeCampaignWatch(request(other), watch.id, {
      action: 'claim',
      expectedRevision: 0,
      reason: 'Take responsibility',
    });
    expect(claimed.ownerId).toBe(other);
    await expect(
      changeCampaignWatch(request(), watch.id, { action: 'close', expectedRevision: 0, reason: 'Monitoring complete' })
    ).rejects.toThrow('changed');
    const checked = await changeCampaignWatch(request(other), watch.id, {
      action: 'check',
      expectedRevision: claimed.revision,
      reason: 'Reviewed account activity',
    });
    expect(checked.lastCheckedAt).toBeInstanceOf(Date);
    const closed = await changeCampaignWatch(request(other), watch.id, {
      action: 'close',
      expectedRevision: checked.revision,
      reason: 'Monitoring complete',
    });
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect((await listCampaignWatches('open')).items).toEqual([]);
    expect((await listCampaignWatches('closed')).items[0].id).toBe(watch.id);
    const reopened = await changeCampaignWatch(request(), watch.id, {
      action: 'reopen',
      expectedRevision: closed.revision,
      reason: 'Continue monitoring',
    });
    expect(reopened.status).toBe('open');
    expect(reopened.userIds).toEqual(input.userIds);
  });

  it('rolls back a lifecycle change if its audit write fails', async () => {
    const { watch } = await createCampaignWatch(request(), input);
    mocks.audit.mockRejectedValue(new Error('audit unavailable'));
    await expect(
      changeCampaignWatch(request(), watch.id, {
        action: 'close',
        expectedRevision: 0,
        reason: 'Monitoring complete',
      })
    ).rejects.toThrow('audit unavailable');
    const persisted = (await campaignWatchDetail(watch.id)).watch;
    expect(persisted.status).toBe('open');
    expect(persisted.revision).toBe(0);
  });

  it('reconciles a deletion committed while creation still holds the original user snapshot', async () => {
    mocks.audit.mockImplementationOnce(async () => {
      await User.deleteOne({ _id: first });
    });
    const { watch } = await createCampaignWatch(request(), input);
    expect(watch.userIds).toEqual([second]);
    expect((await campaignWatchDetail(watch.id)).watch.userIds).toEqual([second]);
  });

  it('removes deleted members and clears deleted owners without deleting a shared watch', async () => {
    const { watch } = await createCampaignWatch(request(), input);
    await campaignWatchRepository.removeUser(first);
    await campaignWatchRepository.removeUser(owner);
    const details = await campaignWatchDetail(watch.id);
    expect(details.watch.userIds).toEqual([second]);
    expect(details.watch.ownerId).toBeNull();
    expect(details.watch.status).toBe('open');
  });
});
