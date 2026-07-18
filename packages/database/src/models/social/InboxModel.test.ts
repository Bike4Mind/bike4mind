import { describe, it, expect, beforeEach } from 'vitest';
import { InboxType } from '@bike4mind/common';
import { User } from '../auth/UserModel';
import { inboxRepository } from './InboxModel';
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
    expect(sender.phone).toBe('+15551112222');
    expect(sender.photoUrl).toBe('https://cdn/sender.png');
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
