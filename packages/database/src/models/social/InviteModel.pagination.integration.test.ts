import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { InviteType } from '@bike4mind/common';
import { MONGO_TEST_TIMEOUT_MS, createMongoServer } from '../../__test__/createMongoServer';
import { Invite, inviteRepository } from './InviteModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

describe('invite keyset pagination', () => {
  let mongoServer: MongoMemoryServer;
  const projectId = '65a000000000000000000001';
  const ids = [1, 2, 3, 4, 5].map(value => `65d00000000000000000000${value}`);

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  });

  afterEach(async () => {
    await Invite.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  async function seedInvites() {
    // Deliberately insert out of order, mixing another document and another resource type.
    await Invite.create([
      { _id: ids[4], documentId: projectId, type: InviteType.Project, recipients: { accepted: ['a@example.com'] } },
      { _id: ids[2], documentId: projectId, type: InviteType.Session, recipients: { pending: ['a@example.com'] } },
      { _id: ids[0], documentId: projectId, type: InviteType.Project, recipients: { pending: ['a@example.com'] } },
      {
        _id: ids[3],
        documentId: 'another-project',
        type: InviteType.Project,
        recipients: { pending: ['a@example.com'] },
      },
      { _id: ids[1], documentId: projectId, type: InviteType.Project, recipients: { pending: ['b@example.com'] } },
    ]);
  }

  it('bounds and orders pages by id, excluding other documents and resource types', async () => {
    await seedInvites();
    const first = await inviteRepository.findPageByDocumentId(projectId, { type: InviteType.Project, limit: 2 });
    expect(first.map(invite => invite.id)).toEqual(ids.slice(0, 2));

    const second = await inviteRepository.findPageByDocumentId(projectId, {
      type: InviteType.Project,
      afterId: first[1].id,
      limit: 2,
    });
    expect(second.map(invite => invite.id)).toEqual([ids[4]]);
  });

  it('filters recipient status before applying the keyset and page limit', async () => {
    await seedInvites();
    const pending = await inviteRepository.findPageByDocumentId(projectId, {
      type: InviteType.Project,
      status: 'pending',
      afterId: ids[0],
      limit: 1,
    });
    expect(pending.map(invite => invite.id)).toEqual([ids[1]]);
    const accepted = await inviteRepository.findPageByDocumentId(projectId, {
      type: InviteType.Project,
      status: 'accepted',
      limit: 1,
    });
    expect(accepted.map(invite => invite.id)).toEqual([ids[4]]);
  });
  it('filters named rows before link pagination and omits recipient histories while retaining counts', async () => {
    await Invite.create([
      {
        _id: ids[0],
        documentId: projectId,
        type: InviteType.Organization,
        isLinkOnly: false,
        recipients: { pending: ['named@example.test'] },
      },
      {
        _id: ids[1],
        documentId: projectId,
        type: InviteType.Organization,
        isLinkOnly: true,
        accepted: 12,
        recipients: { accepted: Array.from({ length: 12 }, (_, index) => `person${index}@example.test`) },
      },
      { _id: ids[2], documentId: projectId, type: InviteType.Organization, isLinkOnly: false },
      { _id: ids[3], documentId: projectId, type: InviteType.Organization, isLinkOnly: true, revokedAt: new Date() },
      {
        _id: ids[4],
        documentId: projectId,
        type: InviteType.Organization,
        isLinkOnly: true,
        expiresAt: new Date(0),
        remaining: 0,
      },
    ]);
    const first = await inviteRepository.findPageByDocumentId(projectId, {
      type: InviteType.Organization,
      linkOnly: true,
      limit: 2,
    });
    expect(first.map(invite => invite.id)).toEqual([ids[1], ids[3]]);
    expect(first[0].accepted).toBe(12);
    expect(first[0].recipients).toBeUndefined();
    expect(first[1].revokedAt).toBeInstanceOf(Date);
    const last = await inviteRepository.findPageByDocumentId(projectId, {
      type: InviteType.Organization,
      linkOnly: true,
      afterId: ids[3],
      limit: 2,
    });
    expect(last.map(invite => invite.id)).toEqual([ids[4]]);
    expect(last[0].remaining).toBe(0);
  });

  it('builds the document/type serving index idempotently', async () => {
    await Invite.createIndexes();
    await Invite.createIndexes();
    const indexes = await Invite.collection.indexes();
    expect(indexes.find(index => index.name === 'invite_document_type')?.key).toEqual({ documentId: 1, type: 1 });
  });
});
