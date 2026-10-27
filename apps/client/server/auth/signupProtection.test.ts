import { describe, expect, it, vi } from 'vitest';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { signupProtection } from './signupProtection';

vi.mock('@bike4mind/database', () => ({ signupProtectionRepository: {} }));
vi.mock('@server/integrations/slack/slack', () => ({ postMessageToSlack: vi.fn().mockResolvedValue(true) }));

describe('signup protection alerts', () => {
  it('escapes Slack markup in the domain, reason, and sample emails', async () => {
    await signupProtection.notifyHold!({
      domain: '<example.net>',
      status: 'held_pending_review',
      reason: 'burst & <review>',
      triggeredAt: new Date(),
      cohortUserIds: [],
      sampleEmails: ['<person>@example.net', 'other&person@example.net'],
      signupCount: 5,
    });

    expect(postMessageToSlack).toHaveBeenCalledWith(
      expect.stringContaining(
        'Signup domain held: &lt;example.net&gt;\n' +
          '5 verified signups. burst &amp; &lt;review&gt;\n' +
          'Samples: &lt;person&gt;@example.net, other&amp;person@example.net\n'
      ),
      'SlackSecurityAlertsWebhookUrl',
      { timeoutMs: 3000 }
    );
  });
});
