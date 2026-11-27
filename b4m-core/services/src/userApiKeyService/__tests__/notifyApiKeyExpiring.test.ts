import { describe, expect, it, vi } from 'vitest';
import { notifyApiKeyExpiring, renderApiKeyExpiringEmail } from '../notifyApiKeyExpiring';

const expiresAt = new Date('2027-01-14T08:00:00Z');

describe('renderApiKeyExpiringEmail', () => {
  it('names the key and date, links the renewal page, and escapes the key name', () => {
    const { subject, html } = renderApiKeyExpiringEmail('<b>mcp\nkey</b>', expiresAt, 'https://app.example.com/x');
    expect(subject).toBe('Your API key "<b>mcp key</b>" expires on 2027-01-14');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('href="https://app.example.com/x"');
  });
});

describe('notifyApiKeyExpiring', () => {
  const deps = (emails: { email: string }[], send = vi.fn().mockResolvedValue(true)) => ({
    db: { users: { findActiveEmailsByIds: vi.fn().mockResolvedValue(emails) } },
    mailer: { sendEmail: send },
    logger: { warn: vi.fn() },
  });
  const context = { holderUserId: 'u1', keyName: 'k', expiresAt, renewUrl: null };

  it('emails the owner', async () => {
    const d = deps([{ email: 'o@example.com' }]);
    await notifyApiKeyExpiring(context, d as never);
    expect(d.mailer.sendEmail).toHaveBeenCalledWith(
      'o@example.com',
      expect.objectContaining({ subject: expect.any(String) })
    );
  });

  it('skips an owner with no active email, and never throws', async () => {
    const d = deps([]);
    await notifyApiKeyExpiring(context, d as never);
    expect(d.mailer.sendEmail).not.toHaveBeenCalled();
    const failing = deps([{ email: 'o@example.com' }], vi.fn().mockRejectedValue(new Error('smtp')));
    await expect(notifyApiKeyExpiring(context, failing as never)).resolves.toBeUndefined();
    expect(failing.logger.warn).toHaveBeenCalled();
  });
});
