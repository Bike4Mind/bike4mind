import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Annotation } from './AnnotationModel';
import { PublishedArtifact, shareTokenFilter } from './PublishedArtifactModel';
import { PublishedArtifactReport } from './PublishedArtifactReportModel';
import { PublishedArtifactViewAuditModel } from './PublishedArtifactViewAuditModel';
import { purgeOwnerPublishedArtifacts } from './purgeOwnerPublishedArtifacts';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

let seq = 0;
const makeArtifact = (ownerId: string, over: Record<string, unknown> = {}) => {
  seq += 1;
  return PublishedArtifact.create({
    publicId: `pub-${seq}`,
    tier: 'user',
    scopeId: ownerId,
    slug: `slug-${seq}`,
    title: 'T',
    ownerId,
    visibility: 'public',
    source: { kind: 'bundle' },
    ...over,
  });
};

const seedChildren = async (publicId: string) => {
  await Annotation.create({ publicId, authorId: 'viewer', authorDisplayName: 'V', body: 'hi' });
  await PublishedArtifactReport.create({ publicId, artifactId: 'a', reporterId: 'viewer', reason: 'spam' });
  await PublishedArtifactViewAuditModel.create({ publicId, viewerId: 'viewer', gateKind: 'domain' });
};

describe('purgeOwnerPublishedArtifacts', () => {
  it("soft-deletes the owner's live artifacts so their share tokens stop resolving", async () => {
    const a = await makeArtifact('owner1', { shareToken: 'tok-1' });
    const b = await makeArtifact('owner1', { visibility: 'private', source: { kind: 'reply' } });

    const result = await purgeOwnerPublishedArtifacts('owner1', { deletedBy: 'admin1' });

    expect(result.artifacts.map(x => x.publicId).sort()).toEqual([a.publicId, b.publicId].sort());
    expect(result.artifacts.find(x => x.publicId === b.publicId)).toMatchObject({
      visibility: 'private',
      source: { kind: 'reply' },
    });
    const rows = await PublishedArtifact.find({ ownerId: 'owner1' }).lean();
    expect(rows.every(r => r.deletedAt instanceof Date && r.deletedBy === 'admin1')).toBe(true);
    expect(await PublishedArtifact.findOne({ deletedAt: null, ...shareTokenFilter('tok-1') })).toBeNull();
  });

  it('cleans up annotations, open reports and view audits on those artifacts', async () => {
    const a = await makeArtifact('owner1');
    await seedChildren(a.publicId);

    const result = await purgeOwnerPublishedArtifacts('owner1', { deletedBy: 'admin1' });

    expect(result).toMatchObject({ annotations: 1, reports: 1, viewAudits: 1 });
    expect(await Annotation.countDocuments({ publicId: a.publicId, deletedAt: null })).toBe(0);
    expect(await PublishedArtifactReport.countDocuments({ publicId: a.publicId, status: 'open' })).toBe(0);
    expect(await PublishedArtifactViewAuditModel.countDocuments({ publicId: a.publicId })).toBe(0);
  });

  it("leaves other owners' artifacts and children alone", async () => {
    const other = await makeArtifact('owner2');
    await seedChildren(other.publicId);
    await makeArtifact('owner1');

    await purgeOwnerPublishedArtifacts('owner1', { deletedBy: 'admin1' });

    expect(await PublishedArtifact.countDocuments({ ownerId: 'owner2', deletedAt: null })).toBe(1);
    expect(await Annotation.countDocuments({ publicId: other.publicId, deletedAt: null })).toBe(1);
    expect(await PublishedArtifactReport.countDocuments({ publicId: other.publicId, status: 'open' })).toBe(1);
    expect(await PublishedArtifactViewAuditModel.countDocuments({ publicId: other.publicId })).toBe(1);
  });

  it('is idempotent and still sweeps children of artifacts deleted earlier', async () => {
    const a = await makeArtifact('owner1');
    await purgeOwnerPublishedArtifacts('owner1', { deletedBy: 'admin1' });
    const firstDeletedAt = (await PublishedArtifact.findOne({ publicId: a.publicId }).lean())!.deletedAt;
    // A child written after the first run (or left behind by a failed one).
    await seedChildren(a.publicId);

    const second = await purgeOwnerPublishedArtifacts('owner1', { deletedBy: 'admin1' });

    expect(second.artifacts).toEqual([]);
    expect(second).toMatchObject({ annotations: 1, reports: 1, viewAudits: 1 });
    expect((await PublishedArtifact.findOne({ publicId: a.publicId }).lean())!.deletedAt).toEqual(firstDeletedAt);

    const third = await purgeOwnerPublishedArtifacts('owner1', { deletedBy: 'admin1' });
    expect(third).toEqual({ artifacts: [], annotations: 0, reports: 0, viewAudits: 0 });
  });

  it('leaves the artifacts live when the child sweep fails, so a re-run finishes the job', async () => {
    const a = await makeArtifact('owner1');
    await seedChildren(a.publicId);
    const spy = vi.spyOn(Annotation, 'updateMany').mockRejectedValueOnce(new Error('boom'));

    await expect(purgeOwnerPublishedArtifacts('owner1', { deletedBy: 'admin1' })).rejects.toThrow('boom');
    spy.mockRestore();
    expect(await PublishedArtifact.countDocuments({ ownerId: 'owner1', deletedAt: null })).toBe(1);

    const retry = await purgeOwnerPublishedArtifacts('owner1', { deletedBy: 'admin1' });
    expect(retry.artifacts.map(x => x.publicId)).toEqual([a.publicId]);
    expect(await Annotation.countDocuments({ publicId: a.publicId, deletedAt: null })).toBe(0);
    expect(await PublishedArtifact.countDocuments({ ownerId: 'owner1', deletedAt: null })).toBe(0);
  });

  it('is a no-op for a user who never published', async () => {
    expect(await purgeOwnerPublishedArtifacts('nobody', { deletedBy: 'admin1' })).toEqual({
      artifacts: [],
      annotations: 0,
      reports: 0,
      viewAudits: 0,
    });
  });
});
