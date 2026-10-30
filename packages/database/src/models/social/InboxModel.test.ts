import { describe, it, expect, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { InboxType } from '@bike4mind/common';
import { User } from '../auth/UserModel';
import { Inbox, inboxRepository } from './InboxModel';
import { setupMongoTest } from '../../__test__/utils';

/**
 * Guards that the inbox sender lookup projects only the fields the UI needs.
 * An aggregation `$lookup` bypasses Mongoose `select:false`, so a bare lookup
 * would pull in the full sender user doc (including secret fields). The
 * `$project` in findByReceiverId must keep only name/username/email/phone/
 * photoUrl for the SenderInfoModal.
 */
describe('InboxModel.findByReceiverId sender projection', () => {
  setupMongoTest();

  let receiverId: string;
  let senderId: string;

  beforeEach(async () => {
    await User.deleteMany({});
    const sender = await User.create({
      username: 'sender',
      email: 'sender@example.com',
      name: 'Sender Person',
      phone: '+15551112222',
      photoUrl: 'https://cdn/sender.png',
      // Secrets that must NOT reach the receiver:
      password: 'BCRYPT-HASH',
      mfa: { totpEnabled: true, totpSecret: 'TOTP-SECRET', backupCodes: ['BK1', 'BK2'], setupAt: new Date() },
      googleDrive: { accessToken: 'GD-ACCESS', refreshToken: 'GD-REFRESH', expiresAt: new Date() },
      atlassianConnect: {
        accessToken: 'ATL-ACCESS',
        refreshToken: 'ATL-REFRESH',
        expiresAt: new Date(),
        siteName: 'acme',
        resources: [],
        connectedAt: new Date(),
      },
      blogIntegration: { apiKey: 'BLOG-KEY', baseUrl: 'https://blog' },
    });
    const receiver = await User.create({ username: 'receiver', email: 'receiver@example.com', name: 'Receiver' });
    receiverId = receiver.id;
    senderId = sender.id;

    await inboxRepository.createInboxMessage({
      userId: sender.id,
      receiverId,
      title: 'Hi',
      message: 'Hello there',
      type: InboxType.COMMON,
    });
  });

  const getSender = (msg: unknown): Record<string, unknown> =>
    (msg as { sender?: Record<string, unknown> }).sender ?? {};

  it('returns the sender fields the inbox UI reads', async () => {
    const [msg] = await inboxRepository.findByReceiverId(receiverId);
    const sender = getSender(msg);
    expect(sender.id).toBe(senderId);
    expect(sender.name).toBe('Sender Person');
    expect(sender.username).toBe('sender');
    expect(sender.email).toBe('sender@example.com');
    expect(sender.photoUrl).toBe('https://cdn/sender.png');
  });

  it('does not project the sender phone number', async () => {
    // Every inbox message used to hand the receiver the sender's phone number, whether or not
    // the sender had ever shared it. SenderInfoModal no longer renders it, so nothing reads it.
    const [msg] = await inboxRepository.findByReceiverId(receiverId);
    expect('phone' in getSender(msg)).toBe(false);
    expect(JSON.stringify(msg)).not.toContain('+15551112222');
  });

  it('excludes the sender secret fields from the response', async () => {
    const [msg] = await inboxRepository.findByReceiverId(receiverId);
    const sender = getSender(msg);
    expect('password' in sender).toBe(false);
    expect('mfa' in sender).toBe(false);
    expect('googleDrive' in sender).toBe(false);
    expect('atlassianConnect' in sender).toBe(false);
    expect('blogIntegration' in sender).toBe(false);

    // Belt-and-suspenders: no secret value appears anywhere in the serialized message.
    const json = JSON.stringify(msg);
    for (const secret of [
      'BCRYPT-HASH',
      'TOTP-SECRET',
      'BK1',
      'GD-ACCESS',
      'GD-REFRESH',
      'ATL-ACCESS',
      'ATL-REFRESH',
      'BLOG-KEY',
    ]) {
      expect(json).not.toContain(secret);
    }
  });
});

describe('InboxModel keyed notices', () => {
  setupMongoTest();

  const notice = (sourceKey: string) => ({
    userId: 'SYSTEM',
    receiverId: 'owner-1',
    title: 'Loop needs you',
    message: 'Out of credits',
    type: InboxType.LOOP,
    sourceKey,
    link: '/loops/abc',
  });

  beforeEach(async () => {
    await Inbox.deleteMany({});
    await Inbox.syncIndexes();
  });

  it('creates once per open key and lists it by prefix', async () => {
    expect(await inboxRepository.upsertKeyedNotice(notice('loop:a:status:error'))).toBe(true);
    expect(await inboxRepository.upsertKeyedNotice(notice('loop:a:status:error'))).toBe(false);
    await inboxRepository.upsertKeyedNotice(notice('other:a'));

    expect(await Inbox.countDocuments({ sourceKey: 'loop:a:status:error' })).toBe(1);
    const open = await inboxRepository.listOpenKeyed('loop:');
    expect(open.map(n => n.sourceKey)).toEqual(['loop:a:status:error']);
  });

  it('resolve soft-deletes and frees the key for a recurrence', async () => {
    await inboxRepository.upsertKeyedNotice(notice('loop:a:status:error'));
    const [open] = await inboxRepository.listOpenKeyed('loop:');
    await inboxRepository.resolveKeyed([open.id]);

    expect(await inboxRepository.listOpenKeyed('loop:')).toEqual([]);
    // The soft-delete plugin hides deleted docs from model queries; read the raw collection.
    const resolved = await Inbox.collection.findOne({ _id: new mongoose.Types.ObjectId(open.id) });
    expect(resolved?.deletedAt).toBeInstanceOf(Date);
    expect(resolved?.sourceKey).toBeUndefined();

    expect(await inboxRepository.upsertKeyedNotice(notice('loop:a:status:error'))).toBe(true);
    expect(await inboxRepository.listOpenKeyed('loop:')).toHaveLength(1);
  });
});
