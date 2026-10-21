import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getSettingsValue: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: { getSettingsValue: h.getSettingsValue } }));

import { isDriveLakePollScheduled } from './drivePollSchedule';

const flags = (on: Record<string, boolean>) =>
  h.getSettingsValue.mockImplementation(async (key: string) => on[key] ?? false);

describe('isDriveLakePollScheduled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is on only when both the parent and the poll flag are on', async () => {
    flags({ EnableDataLakes: true, EnableDataLakeDrivePoll: true });
    expect(await isDriveLakePollScheduled()).toBe(true);
    flags({ EnableDataLakes: true });
    expect(await isDriveLakePollScheduled()).toBe(false);
    flags({ EnableDataLakeDrivePoll: true });
    expect(await isDriveLakePollScheduled()).toBe(false);
  });

  it('is off on self-host, which never schedules the poll cron, whatever the flags say', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    flags({ EnableDataLakes: true, EnableDataLakeDrivePoll: true });
    expect(await isDriveLakePollScheduled()).toBe(false);
  });
});
