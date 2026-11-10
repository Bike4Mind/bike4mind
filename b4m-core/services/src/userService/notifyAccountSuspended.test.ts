import { describe, expect, it, vi } from 'vitest';
import { notifyAccountSuspended, renderAccountSuspendedEmail } from './notifyAccountSuspended';

describe('renderAccountSuspendedEmail', () => {
  it('carries the shared notice, the policy link and the appeal address', () => {
    const { subject, html } = renderAccountSuspendedEmail({
      category: 'payment_fraud',
      supportEmail: 'support@example.com',
      policyUrl: 'https://example.com/terms-of-service',
    });
    expect(subject).toBe('Your account has been suspended');
    expect(html).toContain('fraudulent or unauthorized payment activity');
    expect(html).toContain('appeal by emailing support@example.com');
    expect(html).toContain('href="https://example.com/terms-of-service"');
  });

  it('omits the policy link when there is no website', () => {
    expect(renderAccountSuspendedEmail({ category: 'terms_violation' }).html).not.toContain('<a ');
  });
});

describe('notifyAccountSuspended', () => {
  const deps = (emails: { email: string }[], sendResult: unknown = { messageId: 'm' }) => ({
    db: { users: { findActiveEmailsByIds: vi.fn().mockResolvedValue(emails) } },
    mailer: { sendEmail: vi.fn().mockResolvedValue(sendResult) },
    logger: { warn: vi.fn() },
  });

  it('emails the active address', async () => {
    const d = deps([{ email: 'user@example.com' }]);
    await notifyAccountSuspended({ userId: 'u1', category: 'automated_misuse' }, d as never);
    expect(d.mailer.sendEmail).toHaveBeenCalledWith(
      'user@example.com',
      expect.objectContaining({ subject: expect.any(String) })
    );
  });

  it('skips a user with no active email and never throws on a mail failure', async () => {
    const none = deps([]);
    await notifyAccountSuspended({ userId: 'u1', category: 'automated_misuse' }, none as never);
    expect(none.mailer.sendEmail).not.toHaveBeenCalled();

    const failing = deps([{ email: 'user@example.com' }]);
    failing.mailer.sendEmail.mockRejectedValue(new Error('smtp down'));
    await expect(notifyAccountSuspended({ userId: 'u1', category: 'x' }, failing as never)).resolves.toBeUndefined();
    expect(failing.logger.warn).toHaveBeenCalled();
  });
});
