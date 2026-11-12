import { describe, it, expect, vi } from 'vitest';
import { notifyApiKeyRevokedByOrg, renderApiKeyRevokedByOrgEmail } from '../notifyApiKeyRevokedByOrg';

const makeDb = (emailRows: { id: string; email: string }[] = [{ id: 'user-1', email: 'holder@example.test' }]) => ({
  users: { findActiveEmailsByIds: vi.fn().mockResolvedValue(emailRows) },
});
const context = { holderUserId: 'user-1', keyName: 'My Key', organizationName: 'Acme' };

describe('renderApiKeyRevokedByOrgEmail', () => {
  it('names the key and the org, escaping both in the body', () => {
    const { subject, html } = renderApiKeyRevokedByOrgEmail('<b>K&</b>', 'A "co"');
    expect(subject).toContain('<b>K&</b>');
    expect(html).toContain('&lt;b&gt;K&amp;&lt;/b&gt;');
    expect(html).toContain('A &quot;co&quot;');
    expect(html).not.toContain('<b>K');
  });

  it('strips CR and LF from the subject', () => {
    expect(renderApiKeyRevokedByOrgEmail('Key\r\nBcc: x@example.test', 'Acme').subject).not.toMatch(/[\r\n]/);
    expect(renderApiKeyRevokedByOrgEmail('Key\rBcc', 'Acme').subject).not.toMatch(/[\r\n]/);
  });
});

describe('notifyApiKeyRevokedByOrg', () => {
  it('emails the key holder', async () => {
    const db = makeDb();
    const mailer = { sendEmail: vi.fn().mockResolvedValue(true) };
    await notifyApiKeyRevokedByOrg(context, { db, mailer });
    expect(db.users.findActiveEmailsByIds).toHaveBeenCalledWith(['user-1']);
    expect(mailer.sendEmail).toHaveBeenCalledWith(
      'holder@example.test',
      expect.objectContaining({ subject: expect.stringContaining('My Key') })
    );
  });

  it('warns and sends nothing when the holder has no active email', async () => {
    const mailer = { sendEmail: vi.fn() };
    const logger = { warn: vi.fn() };
    await notifyApiKeyRevokedByOrg(context, { db: makeDb([]), mailer, logger });
    expect(mailer.sendEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no active email'), expect.anything());
  });

  it('never throws when the mailer does', async () => {
    const logger = { warn: vi.fn() };
    const mailer = { sendEmail: vi.fn().mockRejectedValue(new Error('smtp down')) };
    await expect(notifyApiKeyRevokedByOrg(context, { db: makeDb(), mailer, logger })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.anything());
  });
});
