import { describe, it, expect, vi, beforeEach } from 'vitest';

const publish = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/eventBus', () => ({ EmailEvents: { Send: { publish } } }));

import { buildEmailChangeMailer, publishEmailChangeMessages, type EmailChangeMessage } from './emailChangeMailer';

process.env.APP_URL = 'https://app.test';

const user = { username: '<b>x</b>', email: 'old&co@b.test' };

describe('buildEmailChangeMailer', () => {
  it('buffers an escaped notification to the current address with a cancel link', async () => {
    const outbox: EmailChangeMessage[] = [];

    await buildEmailChangeMailer(outbox).sendEmailChangeNotification(user, 'new@b.test');

    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe('old&co@b.test');
    expect(outbox[0].subject).toBe('Security Alert: Email Change Request');
    expect(outbox[0].body).toContain('Hello &lt;b&gt;x&lt;/b&gt;,');
    expect(outbox[0].body).toContain('https://app.test/profile?action=cancel-email-change');
    expect(outbox[0].body).not.toContain('An administrator');
  });

  it('buffers a verification to the new address naming both addresses', async () => {
    const outbox: EmailChangeMessage[] = [];

    await buildEmailChangeMailer(outbox).sendEmailChangeVerification(user, 'new@b.test', 'tok-1');

    expect(outbox[0].to).toBe('new@b.test');
    expect(outbox[0].subject).toBe('Confirm Your Email Address Change');
    expect(outbox[0].body).toContain('from <strong>old&amp;co@b.test</strong> to <strong>new@b.test</strong>');
    expect(outbox[0].body).toContain('/verify-change');
    expect(outbox[0].body).toContain('tok-1');
  });

  it('words the verification as adding a first address for an emailless account', async () => {
    const outbox: EmailChangeMessage[] = [];

    await buildEmailChangeMailer(outbox).sendEmailChangeVerification({ ...user, email: null }, 'new@b.test', 'tok');

    expect(outbox[0].subject).toBe('Confirm Your Email Address');
    expect(outbox[0].body).toContain('You requested to add <strong>new@b.test</strong>');
  });

  it('notes an administrator started the change and does not say the user requested it', async () => {
    const outbox: EmailChangeMessage[] = [];
    const mailer = buildEmailChangeMailer(outbox, { adminNote: 'started' });

    await mailer.sendEmailChangeNotification({ ...user, email: undefined }, 'new@b.test');
    await mailer.sendEmailChangeVerification(user, 'new@b.test', 'tok');
    await mailer.sendEmailChangeVerification({ ...user, email: null }, 'new@b.test', 'tok');

    expect(outbox.every(message => message.body.includes('An administrator started this email change'))).toBe(true);
    expect(outbox[0].body).toContain('<strong>Current email:</strong> </p>');
    expect(outbox[1].body).toContain('A request was made to change your email address from');
    expect(outbox[2].body).toContain('A request was made to add <strong>new@b.test</strong>');
    expect(outbox.some(message => message.body.includes('You requested'))).toBe(false);
  });

  it('notes an administrator resent the link', async () => {
    const outbox: EmailChangeMessage[] = [];
    await buildEmailChangeMailer(outbox, { adminNote: 'resent' }).sendEmailChangeVerification(
      user,
      'new@b.test',
      'tok'
    );

    expect(outbox[0].body).toContain('An administrator has resent your email change verification link.');
  });

  it('uses APP_NAME as the brand when it is set', async () => {
    const previous = process.env.APP_NAME;
    process.env.APP_NAME = 'Brand';
    const outbox: EmailChangeMessage[] = [];
    try {
      await buildEmailChangeMailer(outbox).sendEmailChangeNotification(user, 'n@b.test');
      await buildEmailChangeMailer(outbox).sendEmailChangeVerification(user, 'n@b.test', 'tok');
    } finally {
      if (previous === undefined) delete process.env.APP_NAME;
      else process.env.APP_NAME = previous;
    }
    expect(outbox).toHaveLength(2);
  });
});

describe('publishEmailChangeMessages', () => {
  beforeEach(() => publish.mockReset());

  it('publishes every message and logs a failed one without throwing', async () => {
    const logger = { error: vi.fn() };
    publish
      .mockRejectedValueOnce(new Error('queue down'))
      .mockRejectedValueOnce('boom')
      .mockResolvedValueOnce(undefined);
    const outbox = [
      { to: 'a@b.test', subject: 's', body: 'b' },
      { to: 'c@b.test', subject: 's', body: 'b' },
      { to: 'd@b.test', subject: 's', body: 'b' },
    ];

    await publishEmailChangeMessages(outbox, logger, 'user-1');

    expect(publish).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledWith('Failed to publish email-change notification after commit', {
      userId: 'user-1',
      to: 'a@b.test',
      error: 'queue down',
    });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: 'boom' }));
  });
});
