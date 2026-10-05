import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyApiKeyReowned, renderApiKeyReownedEmail } from '../notifyApiKeyReowned';

const makeDb = (emailRows: { id: string; email: string }[] = [{ id: 'user-1', email: 'owner@example.test' }]) => ({
  users: { findActiveEmailsByIds: vi.fn().mockResolvedValue(emailRows) },
});

const makeMailer = (result: unknown = true) => ({
  sendEmail: vi.fn().mockResolvedValue(result),
});

describe('renderApiKeyReownedEmail', () => {
  it('includes the key name in the subject and body', () => {
    const { subject, html } = renderApiKeyReownedEmail('My Key');
    expect(subject).toContain('My Key');
    expect(html).toContain('My Key');
  });

  it('escapes all five HTML special characters in the key name', () => {
    const { html } = renderApiKeyReownedEmail('A&B "q" \'x\'');
    expect(html).toContain('A&amp;B');
    expect(html).toContain('&quot;q&quot;');
    expect(html).toContain('&#39;x&#39;');
    expect(html).not.toContain('<script>');
  });

  it('strips CR and LF from the subject to prevent header injection', () => {
    // The newlines are what enable injection - stripping them collapses the
    // injected fragment into the subject value, which is harmless.
    const { subject } = renderApiKeyReownedEmail('Key\r\nBcc: attacker@evil.test');
    expect(subject).not.toMatch(/[\r\n]/);
  });
});

describe('notifyApiKeyReowned', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends email to the previous owner on the happy path', async () => {
    const db = makeDb();
    const mailer = makeMailer();
    await notifyApiKeyReowned({ previousOwnerUserId: 'user-1', keyName: 'My Key' }, { db, mailer });
    expect(db.users.findActiveEmailsByIds).toHaveBeenCalledWith(['user-1']);
    expect(mailer.sendEmail).toHaveBeenCalledWith(
      'owner@example.test',
      expect.objectContaining({ subject: expect.stringContaining('My Key') })
    );
  });

  it('skips silently and warns when the previous owner has no active email', async () => {
    const db = makeDb([]);
    const mailer = makeMailer();
    await expect(
      notifyApiKeyReowned({ previousOwnerUserId: 'user-1', keyName: 'My Key' }, { db, mailer })
    ).resolves.toBeUndefined();
    expect(mailer.sendEmail).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('no active email'),
      expect.objectContaining({ previousOwnerUserId: 'user-1' })
    );
  });

  it('resolves without throwing when the mailer returns false', async () => {
    const db = makeDb();
    const mailer = makeMailer(false);
    await expect(
      notifyApiKeyReowned({ previousOwnerUserId: 'user-1', keyName: 'My Key' }, { db, mailer })
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to send'),
      expect.objectContaining({ previousOwnerUserId: 'user-1' })
    );
  });

  it('resolves without throwing when the mailer rejects', async () => {
    const db = makeDb();
    const mailer = { sendEmail: vi.fn().mockRejectedValue(new Error('SMTP down')) };
    await expect(
      notifyApiKeyReowned({ previousOwnerUserId: 'user-1', keyName: 'My Key' }, { db, mailer })
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      expect.objectContaining({ error: expect.stringContaining('SMTP') })
    );
  });

  it('resolves without throwing when the db lookup rejects', async () => {
    const db = { users: { findActiveEmailsByIds: vi.fn().mockRejectedValue(new Error('DB down')) } };
    const mailer = makeMailer();
    await expect(
      notifyApiKeyReowned({ previousOwnerUserId: 'user-1', keyName: 'My Key' }, { db, mailer })
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      expect.objectContaining({ error: expect.stringContaining('DB') })
    );
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });

  it('uses deps.logger.warn instead of console.warn when a logger is supplied', async () => {
    const db = makeDb([]);
    const mailer = makeMailer();
    const logger = { warn: vi.fn() };
    await notifyApiKeyReowned({ previousOwnerUserId: 'user-1', keyName: 'My Key' }, { db, mailer, logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no active email'),
      expect.objectContaining({ previousOwnerUserId: 'user-1' })
    );
    expect(console.warn).not.toHaveBeenCalled();
  });
});
