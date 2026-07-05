import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { InviteType } from '@bike4mind/common';
// Importing inviteRepository transitively registers the User model it depends on.
import { inviteRepository, Invite } from './InviteModel';

describe('InviteModel — findAllByPendingUserIdOrEmail / countPendingByUserId (#9196, #9228)', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  }, 30000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  }, 30000);

  afterEach(async () => {
    await Invite.deleteMany({});
    if (mongoose.connection.db) {
      await mongoose.connection.db.collection('users').deleteMany({});
    }
    vi.restoreAllMocks();
  });

  /**
   * Insert a user document directly so we can store `email: null` - the exact
   * production condition (emailless accounts are allowed). mongoose `create`
   * with no email would store the field as absent (undefined), not null.
   */
  const insertUserWithEmail = async (email: string | null): Promise<string> => {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('users').insertOne({ _id, email });
    return _id.toString();
  };

  const createPendingInvite = (pendingEmail: string) =>
    Invite.create({
      type: InviteType.Session,
      documentId: new mongoose.Types.ObjectId().toString(),
      recipients: { pending: [pendingEmail], accepted: [], refused: [] },
      remaining: 1,
      accepted: 0,
    });

  it('does not throw or log a MongoServerError for a user with a null email', async () => {
    const userId = await insertUserWithEmail(null);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await inviteRepository.findAllByPendingUserIdOrEmail(userId, { limit: 20, page: 1 });

    expect(result).toEqual([]);
    // The pre-fix bug passed `$regex: null` to MongoDB, which threw
    // "$regex has to be a string" and was logged via console.error('FAILED', ...),
    // tripping the LiveOps ERROR alert.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('countPendingByUserId does not throw for a user with a null email', async () => {
    const userId = await insertUserWithEmail(null);

    await expect(inviteRepository.countPendingByUserId(userId)).resolves.toBe(0);
  });

  it('still returns matching pending invites for a user with a valid email', async () => {
    const email = 'invitee@example.com';
    const userId = await insertUserWithEmail(email);
    await createPendingInvite(email);

    const result = await inviteRepository.findAllByPendingUserIdOrEmail(userId, { limit: 20, page: 1 });

    expect(result).toHaveLength(1);
    expect(result[0].recipients?.pending).toContain(email);
  });

  it('counts matching pending invites for a user with a valid email', async () => {
    const email = 'invitee@example.com';
    const userId = await insertUserWithEmail(email);
    await createPendingInvite(email);

    await expect(inviteRepository.countPendingByUserId(userId)).resolves.toBe(1);
  });

  // The email was used as an unescaped, unanchored $regex pattern.

  it('does not match a different address via an unescaped "." metacharacter (#9228)', async () => {
    // Under an unescaped regex, "a.b@example.com" matches "aXb@example.com"
    // because "." matches any character. It must NOT.
    const userId = await insertUserWithEmail('a.b@example.com');
    await createPendingInvite('aXb@example.com');

    const result = await inviteRepository.findAllByPendingUserIdOrEmail(userId, { limit: 20, page: 1 });

    expect(result).toEqual([]);
    await expect(inviteRepository.countPendingByUserId(userId)).resolves.toBe(0);
  });

  it('does not match a superstring of the email (anchored match, #9228)', async () => {
    // Under an unanchored regex, "foo@bar.com" matches "xfoo@bar.com". It must NOT.
    const userId = await insertUserWithEmail('foo@bar.com');
    await createPendingInvite('xfoo@bar.com');

    const result = await inviteRepository.findAllByPendingUserIdOrEmail(userId, { limit: 20, page: 1 });

    expect(result).toEqual([]);
    await expect(inviteRepository.countPendingByUserId(userId)).resolves.toBe(0);
  });

  it('still matches the same email case-insensitively (#9228)', async () => {
    // Case-insensitivity is the only reason the regex arm exists - preserve it.
    const userId = await insertUserWithEmail('Invitee@Example.com');
    await createPendingInvite('invitee@example.com');

    const result = await inviteRepository.findAllByPendingUserIdOrEmail(userId, { limit: 20, page: 1 });

    expect(result).toHaveLength(1);
    await expect(inviteRepository.countPendingByUserId(userId)).resolves.toBe(1);
  });
});
