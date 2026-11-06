import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __resetAlarmMentionCacheForTesting, readAlarmMention, type MentionReader } from './alarmSlackMention';

const reader = (
  impl: (name: string) => Promise<string | undefined>
): MentionReader & { getParameter: ReturnType<typeof vi.fn> } => ({
  getParameter: vi.fn(impl),
});

describe('readAlarmMention', () => {
  beforeEach(() => {
    __resetAlarmMentionCacheForTesting();
  });

  it('is off when no parameter name is configured and never touches SSM', async () => {
    const ssm = reader(async () => 'channel');
    expect(await readAlarmMention(undefined, ssm)).toBeUndefined();
    expect(await readAlarmMention('   ', ssm)).toBeUndefined();
    expect(ssm.getParameter).not.toHaveBeenCalled();
  });

  it('returns the raw value and caches it for a minute', async () => {
    const ssm = reader(async () => 'channel');
    let now = 1_000;
    expect(await readAlarmMention('/app/production/alarm-slack-mention', ssm, () => now)).toBe('channel');
    now += 30_000;
    expect(await readAlarmMention('/app/production/alarm-slack-mention', ssm, () => now)).toBe('channel');
    expect(ssm.getParameter).toHaveBeenCalledTimes(1);
    now += 31_000;
    await readAlarmMention('/app/production/alarm-slack-mention', ssm, () => now);
    expect(ssm.getParameter).toHaveBeenCalledTimes(2);
  });

  it('is off, and quiet, when the parameter does not exist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ssm = reader(async () => {
      throw Object.assign(new Error('nope'), { name: 'ParameterNotFound' });
    });
    expect(await readAlarmMention('/app/dev/alarm-slack-mention', ssm)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is off, and logs, when the read fails for any other reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ssm = reader(async () => {
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    });
    expect(await readAlarmMention('/app/dev/alarm-slack-mention', ssm)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('AccessDeniedException'));
    warn.mockRestore();
  });
});
