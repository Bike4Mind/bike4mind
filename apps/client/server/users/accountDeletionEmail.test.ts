import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_DELETION_RETAINED_RECORDS } from '@bike4mind/common';

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
    expect(message.subject).toBe('Your account is scheduled for deletion on November 18, 2026 (UTC)');
    expect(message.body).toContain('<strong>November 18, 2026 (UTC)</strong>');
    // The purge removes the account, not all of its data; the complete email lists what goes.
    expect(message.body).toContain('Your account will be permanently deleted on');
    expect(message.body).toContain('href="https://app.example.test/login"');
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
      expect(message.body).toContain(`<strong>${record.category}</strong>`);
      expect(message.body).toContain(`Kept for ${record.retention}.`);
    }
    expect(message.body).toContain('AI model providers');
    expect(message.body).toContain('payment processor');
  });

  it('escapes retained records and says so when none are kept', () => {
    const body = accountDeletionCompleteEmailBody([{ category: '<b>x</b>', reason: 'r', retention: '1 day' }]);
    expect(body).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(accountDeletionCompleteEmailBody([])).toContain('No records are kept after deletion.');
  });
});
