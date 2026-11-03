import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { postMessageToSlackWithOutcome } from '@bike4mind/server-utils/integrations/slack/slack';
import { signupProtection } from './signupProtection';

vi.mock('@bike4mind/database', () => ({ signupProtectionRepository: {} }));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlackWithOutcome: vi.fn() }));

const review = {
  domain: '<example.net>',
  status: 'held_pending_review' as const,
  reason: 'burst & <review>',
  triggeredAt: new Date(),
  cohortUserIds: [],
  sampleEmails: ['<person>@example.net', 'other&person@example.net'],
  signupCount: 5,
};

describe('signup protection alerts', () => {
  beforeEach(() => {
    vi.mocked(postMessageToSlackWithOutcome).mockReset().mockResolvedValue('sent');
    vi.restoreAllMocks();
    vi.spyOn(Logger.globalInstance, 'error').mockImplementation(() => undefined);
  });

  it('escapes Slack markup in the domain, reason, and sample emails', async () => {
    await signupProtection.notifyHold!(review);

    expect(postMessageToSlackWithOutcome).toHaveBeenCalledWith(
      expect.stringContaining(
        'Signup domain held: &lt;example.net&gt;\n' +
          '5 verified signups. burst &amp; &lt;review&gt;\n' +
          'Samples: &lt;person&gt;@example.net, other&amp;person@example.net\n'
      ),
      'SlackSecurityAlertsWebhookUrl',
      { timeoutMs: 3000 }
    );
  });

  it('logs nothing extra when security alerts are turned off', async () => {
    vi.mocked(postMessageToSlackWithOutcome).mockResolvedValue('unconfigured');
    await signupProtection.notifyHold!(review);
    expect(Logger.globalInstance.error).not.toHaveBeenCalled();
  });

  it('logs the held domain when delivery fails', async () => {
    vi.mocked(postMessageToSlackWithOutcome).mockResolvedValue('failed');
    await signupProtection.notifyHold!(review);
    expect(Logger.globalInstance.error).toHaveBeenCalledWith('Signup domain hold alert was not delivered', {
      domain: '<example.net>',
    });
  });
});
