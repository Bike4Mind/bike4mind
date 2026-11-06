import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_DELETION_RETAINED_RECORDS } from '@bike4mind/common';
import { escapeHtml } from '@bike4mind/server-utils/utils/mailer/emailHelpers';

const publish = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish } } }));

import { PURGED_USER_DATA } from '@server/services/purgeDeletedUserData';
import {
  accountDeletionCancelledEmailBody,
  accountDeletionCompleteEmailBody,
  accountDeletionScheduledEmailBody,
  sendAccountDeletionCancelledEmail,
  sendAccountDeletionCompleteEmail,
  sendAccountDeletionScheduledEmail,
} from './accountDeletionEmail';

beforeEach(() => {
  publish.mockReset();
  vi.stubEnv('APP_URL', 'https://app.example.test');
});

describe('deletion-scheduled email', () => {
  it('states the purge date and links to sign in to cancel', async () => {
    await sendAccountDeletionScheduledEmail('dev@example.test', new Date('2026-11-18T12:00:00Z'));

    const [message] = publish.mock.calls[0];
    expect(message.to).toBe('dev@example.test');
    expect(message.subject).toBe('Your account deletion cancellation period ends on November 18, 2026 (UTC)');
    expect(message.body).toContain('<strong>November 18, 2026 (UTC)</strong>');
    expect(message.body).toContain('Your cancellation period ends on');
    expect(message.body).toContain('Permanent deletion begins after that date');
    expect(message.body).toContain('You can cancel until cleanup starts');
    expect(message.body).toContain('href="https://app.example.test/login"');
  });

  it('tells a support-scheduled user to contact support, not to sign in', async () => {
    await sendAccountDeletionScheduledEmail('dev@example.test', new Date('2026-11-18T12:00:00Z'), { source: 'support' });

    const [message] = publish.mock.calls[0];
    expect(message.body).toContain('<strong>November 18, 2026 (UTC)</strong>');
    expect(message.body).toContain('As you asked by email');
    expect(message.body).toContain('Reply to this email or contact support');
    expect(message.body).not.toContain('href=');
  });

  it('keeps the self-serve body when the source is self', () => {
    const date = new Date('2026-11-18T12:00:00Z');
    expect(accountDeletionScheduledEmailBody(date, 'https://x.test/login', { source: 'self' })).toBe(
      accountDeletionScheduledEmailBody(date, 'https://x.test/login')
    );
  });

  it('escapes the sign-in link', () => {
    expect(accountDeletionScheduledEmailBody(new Date(), 'https://x.test/"><script>')).not.toContain('<script>');
  });
});

describe('deletion-cancelled email', () => {
  it('says access is back and that what the request turned off stays off', async () => {
    await sendAccountDeletionCancelledEmail('dev@example.test');

    const [message] = publish.mock.calls[0];
    expect(message.to).toBe('dev@example.test');
    expect(message.subject).toBe('Your account deletion was cancelled');
    const body = accountDeletionCancelledEmailBody();
    expect(message.body).toBe(body);
    expect(body).toContain('will not be deleted');
    expect(body).toContain('subscriptions stay canceled');
    expect(body).toContain('stay revoked');
    expect(body).toContain('stay offline');
    expect(body).toContain('change your password');
  });
});

describe('deletion-complete email', () => {
  it('lists what the purge removed, the retained records and the outside-provider caveat', async () => {
    await sendAccountDeletionCompleteEmail('dev@example.test');

    const [message] = publish.mock.calls[0];
    expect(message.subject).toBe('Your account has been deleted');
    for (const item of PURGED_USER_DATA) expect(message.body).toContain(`<li>${item}</li>`);
    for (const record of ACCOUNT_DELETION_RETAINED_RECORDS) {
      expect(message.body).toContain(`<strong>${escapeHtml(record.category)}</strong>`);
      expect(message.body).toContain(escapeHtml(record.reason));
      expect(message.body).toContain(`Kept for ${escapeHtml(record.retention)}.`);
    }
    expect(message.body).toContain('AI model providers');
    expect(message.body).toContain('payment processor');
    expect(message.body).toContain('Files held by moderation, including their contents and related records');
  });

  it('escapes retained records and says so when none are kept', () => {
    const body = accountDeletionCompleteEmailBody([{ category: '<b>x</b>', reason: 'r', retention: '1 day' }]);
    expect(body).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(accountDeletionCompleteEmailBody([])).toContain('No records are kept after deletion.');
  });
});
