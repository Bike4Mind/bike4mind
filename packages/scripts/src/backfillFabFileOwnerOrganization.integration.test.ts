import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { DataLakeModel, FabFile } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.mock('../utils/config', () => ({ Config: {} }));

import { backfillFabFileOwnerOrganization } from './backfillFabFileOwnerOrganization';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const silent = () => undefined;
const oldLakeId = new mongoose.Types.ObjectId();
const newLakeId = new mongoose.Types.ObjectId();

const file = (name: string, tags: string[], extra: Record<string, unknown> = {}) => ({
  fileName: name,
  userId: 'uploader',
  tags: tags.map(tag => ({ name: tag, strength: 1 })),
  ...extra,
});

beforeEach(async () => {
  await DataLakeModel.collection.deleteMany({});
  await FabFile.collection.deleteMany({});
  await DataLakeModel.collection.insertMany([
    { _id: oldLakeId, datalakeTag: 'datalake:old', organizationId: 'org-a', createdAt: new Date('2025-01-01') },
    { _id: newLakeId, datalakeTag: 'datalake:new', organizationId: 'org-b', createdAt: new Date('2026-01-01') },
    { datalakeTag: 'datalake:mine', createdAt: new Date('2024-01-01') },
  ]);
  await FabFile.collection.insertMany([
    file('org-only', ['datalake:new', 'topic:x']),
    file('personal', ['datalake:mine']),
    file('untagged', []),
    file('both-orgs', ['datalake:new', 'datalake:old']),
    file('both-orgs-sourced', ['datalake:new', 'datalake:old'], { sourceLakeId: String(newLakeId) }),
    file('stamped-other', ['datalake:new'], { organizationId: 'org-z' }),
    file('soft-deleted', ['datalake:old'], { deletedAt: new Date() }),
  ]);
});

const ownerOf = async (fileName: string) =>
  (await FabFile.collection.findOne({ fileName }))?.organizationId as string | undefined;

describe('backfillFabFileOwnerOrganization', () => {
  it('stamps org-lake files, leaves personal ones, and reports ambiguous and conflicting rows', async () => {
    const report = await backfillFabFileOwnerOrganization({ dryRun: false, log: silent });

    expect(await ownerOf('org-only')).toBe('org-b');
    expect(await ownerOf('soft-deleted')).toBe('org-a');
    expect(await ownerOf('personal')).toBeUndefined();
    expect(await ownerOf('untagged')).toBeUndefined();
    // Tiebreak: the ingesting lake wins, else the oldest org lake.
    expect(await ownerOf('both-orgs')).toBe('org-a');
    expect(await ownerOf('both-orgs-sourced')).toBe('org-b');
    // An existing stamp is never overwritten.
    expect(await ownerOf('stamped-other')).toBe('org-z');

    expect(report).toMatchObject({ orgLakes: 2, updated: 4, alreadyOwned: 0 });
    expect(report.ambiguous.map(row => row.chosen).sort()).toEqual(['org-a', 'org-b']);
    expect(report.conflicts).toEqual([expect.objectContaining({ stored: 'org-z', resolved: 'org-b' })]);
  });

  it('writes nothing in a dry run but reports the same counts', async () => {
    const report = await backfillFabFileOwnerOrganization({ dryRun: true, log: silent });

    expect(report.updated).toBe(4);
    expect(await FabFile.collection.countDocuments({ organizationId: { $exists: true } })).toBe(1);
  });

  it('is a no-op on re-run', async () => {
    await backfillFabFileOwnerOrganization({ dryRun: false, log: silent });
    const second = await backfillFabFileOwnerOrganization({ dryRun: false, log: silent });

    expect(second).toMatchObject({ updated: 0, alreadyOwned: 4 });
  });
});
