import { describe, expect, it } from 'vitest';
import { LiveOpsTriageJobMessageSchema } from './liveopsTriageJobMessage';

describe('LiveOpsTriageJobMessageSchema', () => {
  it.each([
    {
      configId: 'config-1',
      configName: 'Scheduled triage',
      dispatchedAt: 1_700_000_000_000,
      source: 'cron',
    },
    {
      configId: 'config-2',
      configName: 'Manual triage',
      dispatchedAt: 1_700_000_000_000,
      source: 'manual',
      dryRun: true,
      lookbackHours: 24,
    },
  ])('accepts a supported $source producer message', message => {
    expect(LiveOpsTriageJobMessageSchema.safeParse(message).success).toBe(true);
  });

  it('rejects the retired legacy job message', () => {
    expect(
      LiveOpsTriageJobMessageSchema.safeParse({
        jobId: 'job-1',
        userId: 'user-1',
        dryRun: false,
        lookbackHours: 24,
      }).success
    ).toBe(false);
  });
});
