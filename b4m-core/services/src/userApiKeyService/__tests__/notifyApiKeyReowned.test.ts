import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('escapes HTML characters in the key name', () => {
    const { html } = renderApiKeyReownedEmail('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('strips newlines from the subject to prevent header injection', () => {
    const { subject } = renderApiKeyReownedEmail('Key\nWith\nNewlines');
    expect(subject).not.toMatch(/\n/);
  });
});

describe('notifyApiKeyReowned', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(console.warn).toHaveBeenCalled();
  });

  it('resolves without throwing when the mailer returns false', async () => {
    const db = makeDb();
    const mailer = makeMailer(false);
    await expect(
      notifyApiKeyReowned({ previousOwnerUserId: 'user-1', keyName: 'My Key' }, { db, mailer })
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
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
    expect(console.warn).toHaveBeenCalled();
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });
});
