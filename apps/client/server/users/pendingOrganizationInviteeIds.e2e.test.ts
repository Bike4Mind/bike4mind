import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { InviteType, type IUserDocument } from '@bike4mind/common';
import { Invite, Organization, User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { findPendingOrganizationInviteeIds } from './pendingOrganizationInviteeIds';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const owner = new mongoose.Types.ObjectId().toString();
const manager = new mongoose.Types.ObjectId().toString();
const member = new mongoose.Types.ObjectId().toString();
const organizationId = new mongoose.Types.ObjectId().toString();
const candidateId = new mongoose.Types.ObjectId().toString();
const expiredId = new mongoose.Types.ObjectId().toString();
const cancelledId = new mongoose.Types.ObjectId().toString();
const actor = (id: string, isAdmin = false) => ({ id, isAdmin }) as IUserDocument;
let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
  await Organization.collection.insertOne({
    _id: new mongoose.Types.ObjectId(organizationId),
    name: 'Organization',
    userId: owner,
    adminUserIds: [manager],
    users: [
      { userId: manager, permissions: ['read'] },
      { userId: member, permissions: ['read'] },
    ],
    deletedAt: null,
  });
  await User.collection.insertMany([
    {
      _id: new mongoose.Types.ObjectId(candidateId),
      username: 'candidate',
      name: 'Candidate',
      email: 'candidate@example.test',
    },
    {
      _id: new mongoose.Types.ObjectId(expiredId),
      username: 'expired',
      name: 'Expired',
      email: 'expired@example.test',
    },
    {
      _id: new mongoose.Types.ObjectId(cancelledId),
      username: 'cancelled',
      name: 'Cancelled',
      email: 'cancelled@example.test',
    },
  ]);
  await Invite.collection.insertMany([
    {
      type: InviteType.Organization,
      documentId: organizationId,
      remaining: 1,
      recipients: { pending: ['CANDIDATE@EXAMPLE.TEST'] },
    },
    {
      type: InviteType.Organization,
      documentId: organizationId,
      remaining: 1,
      recipients: { pending: ['expired@example.test'] },
      expiresAt: new Date(0),
    },
    {
      type: InviteType.Organization,
      documentId: organizationId,
      remaining: 0,
      recipients: { pending: ['cancelled@example.test'] },
    },
    {
      type: InviteType.Organization,
      documentId: organizationId,
      remaining: 1,
      recipients: { pending: [], refused: ['cancelled@example.test'] },
    },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

describe('pending organization invitees', () => {
  it.each([owner, manager])('matches active recipients case-insensitively for a manager', async viewer => {
    const result = await findPendingOrganizationInviteeIds(actor(viewer), organizationId, [
      candidateId,
      expiredId,
      cancelledId,
    ]);
    expect(result).toEqual(new Set([candidateId]));
  });

  it('permits a platform administrator outside the organization', async () => {
    expect(
      await findPendingOrganizationInviteeIds(actor('administrator', true), organizationId, [candidateId])
    ).toEqual(new Set([candidateId]));
  });

  it.each([member, 'outsider'])('returns no annotation to an unauthorized caller', async viewer => {
    expect(await findPendingOrganizationInviteeIds(actor(viewer), organizationId, [candidateId])).toBeNull();
  });

  it('returns no annotation for a missing organization', async () => {
    expect(
      await findPendingOrganizationInviteeIds(actor(owner), new mongoose.Types.ObjectId().toString(), [candidateId])
    ).toBeNull();
  });

  it('handles an empty candidate list and never matches candidates outside the requested set', async () => {
    expect(await findPendingOrganizationInviteeIds(actor(owner), organizationId, [])).toEqual(new Set());
    expect(await findPendingOrganizationInviteeIds(actor(owner), organizationId, [expiredId, cancelledId])).toEqual(
      new Set()
    );
  });
});
