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

  it('emails the owner a subject naming the key and a body with the expiry date and renewal link', async () => {
    const d = deps([{ email: 'o@example.com' }]);
    await expect(
      notifyApiKeyExpiring({ ...context, keyName: 'laptop', renewUrl: 'https://app.example.com/r' }, d as never)
    ).resolves.toBe(true);
    const [to, message] = d.mailer.sendEmail.mock.calls[0];
    expect(to).toBe('o@example.com');
    expect(message.subject).toBe('Your API key "laptop" expires on 2027-01-14');
    expect(message.html).toContain('2027-01-14');
    expect(message.html).toContain('href="https://app.example.com/r"');
  });

  it('treats an owner with no active email as done: nothing a retry could fix', async () => {
    const d = deps([]);
    await expect(notifyApiKeyExpiring(context, d as never)).resolves.toBe(true);
    expect(d.mailer.sendEmail).not.toHaveBeenCalled();
  });

  it('reports false, and never throws, when the mailer refuses or fails', async () => {
    const refusing = deps([{ email: 'o@example.com' }], vi.fn().mockResolvedValue(false));
    await expect(notifyApiKeyExpiring(context, refusing as never)).resolves.toBe(false);
    const failing = deps([{ email: 'o@example.com' }], vi.fn().mockRejectedValue(new Error('smtp')));
    await expect(notifyApiKeyExpiring(context, failing as never)).resolves.toBe(false);
    expect(failing.logger.warn).toHaveBeenCalled();
  });
});
