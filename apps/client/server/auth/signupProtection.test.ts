import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { postMessageToSlackWithOutcome } from '@bike4mind/server-utils/integrations/slack/slack';
import { emitMetrics } from '@bike4mind/server-utils/utils/cloudwatch';
import { signupProtection } from './signupProtection';

vi.mock('@bike4mind/database', () => ({ signupProtectionRepository: {} }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetrics: vi.fn() }));
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

  it('posts the unset drip cap alert to the liveops channel and rejects when undelivered', async () => {
    await signupProtection.notifyConfig!({ setting: 'signupGrantDripCap', fallback: 9000 });
    expect(postMessageToSlackWithOutcome).toHaveBeenCalledWith(
      expect.stringContaining('9,000 credits'),
      'SlackLiveopsWebhookUrl',
      { timeoutMs: 3000 }
    );

    vi.mocked(postMessageToSlackWithOutcome).mockResolvedValue('failed');
    await expect(signupProtection.notifyConfig!({ setting: 'signupGrantDripCap', fallback: 9000 })).rejects.toThrow(
      'Signup grant config alert was not delivered'
    );
  });
});

describe('disposable refusal metric', () => {
  it('emits one SignupRefusals datum per source, dimensioned by stage and source', async () => {
    await signupProtection.recordDisposableRefusal!({ domain: 'burner.test', sources: ['curated', 'tompec'] });

    expect(emitMetrics).toHaveBeenCalledExactlyOnceWith('Lumina5/DisposableDomains', [
      { name: 'SignupRefusals', value: 1, dimensions: { Stage: 'test', Source: 'curated' }, unit: 'Count' },
      { name: 'SignupRefusals', value: 1, dimensions: { Stage: 'test', Source: 'tompec' }, unit: 'Count' },
    ]);
  });
});
