import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { InviteType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Invite, inviteRepository } from './InviteModel';

describe('invite keyset pagination', () => {
  let mongoServer: MongoMemoryServer;
  const projectId = '65a000000000000000000001';
  const ids = [1, 2, 3, 4, 5].map(value => `65d00000000000000000000${value}`);

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  }, 30000);

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
});
