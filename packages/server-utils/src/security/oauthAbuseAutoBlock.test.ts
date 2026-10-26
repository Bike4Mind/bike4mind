import { describe, it, expect, vi } from 'vitest';
import {
  parseEscalationMinutes,
  resolveBlockDurationMs,
  runOauthAbuseAutoBlock,
  type OauthAbusePolicy,
} from './oauthAbuseAutoBlock';

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  authFailLogRepository: {},
  blockedIPRepository: {},
}));

const MIN = 60_000;
const policy: OauthAbusePolicy = {
  enabled: true,
  threshold: 20,
  windowMs: 10 * MIN,
  escalationMs: [10 * MIN, 60 * MIN, 1440 * MIN],
  lookbackMs: 24 * 60 * MIN,
};
const NOW = new Date('2026-01-01T12:00:00Z');

const setup = (overrides: Partial<OauthAbusePolicy> = {}, prior: Record<string, number> = {}) => {
  const block = vi.fn().mockResolvedValue({});
  const getIPsWithHighAttempts = vi.fn().mockResolvedValue([
    { ip: '1.1.1.1', attempts: 25 },
    { ip: '2.2.2.2', attempts: 20 },
  ]);
  const countAutoBlocksSince = vi.fn(async (ip: string) => prior[ip] ?? 0);
  const deps = { loadPolicy: async () => ({ ...policy, ...overrides }), getIPsWithHighAttempts, countAutoBlocksSince, block };
  return { deps, block, getIPsWithHighAttempts, countAutoBlocksSince };
};

describe('runOauthAbuseAutoBlock', () => {
  it('blocks the IPs the log query returns for the configured threshold and window', async () => {
    const { deps, block, getIPsWithHighAttempts } = setup();
    const result = await runOauthAbuseAutoBlock({ now: NOW, deps });

    expect(getIPsWithHighAttempts).toHaveBeenCalledWith(new Date(NOW.getTime() - 10 * MIN), 20);
    expect(result.evaluatedSince).toEqual(new Date(NOW.getTime() - 10 * MIN));
    expect(result.blocked.map(b => b.ip)).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(block).toHaveBeenCalledWith('1.1.1.1', expect.stringContaining('25'), {
      durationMs: 10 * MIN,
      source: 'auto',
      escalationLevel: 0,
    });
  });

  it('writes nothing when disabled', async () => {
    const { deps, block, getIPsWithHighAttempts } = setup({ enabled: false });
    const result = await runOauthAbuseAutoBlock({ now: NOW, deps });
    expect(result.blocked).toEqual([]);
    expect(getIPsWithHighAttempts).not.toHaveBeenCalled();
    expect(block).not.toHaveBeenCalled();
  });

  it('escalates 10m -> 1h -> 24h and clamps, counting priors inside the lookback', async () => {
    const { deps, block, countAutoBlocksSince } = setup({}, { '1.1.1.1': 1, '2.2.2.2': 7 });
    const result = await runOauthAbuseAutoBlock({ now: NOW, deps });

    expect(countAutoBlocksSince).toHaveBeenCalledWith('1.1.1.1', new Date(NOW.getTime() - 24 * 60 * MIN));
    expect(result.blocked.map(b => [b.durationMs, b.escalationLevel])).toEqual([
      [60 * MIN, 1],
      [1440 * MIN, 2],
    ]);
    expect(block).toHaveBeenLastCalledWith(
      '2.2.2.2',
      expect.any(String),
      expect.objectContaining({ escalationLevel: 2 })
    );
  });

  it('keeps going when one IP fails to block', async () => {
    const { deps, block } = setup();
    block.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runOauthAbuseAutoBlock({ now: NOW, deps });
    expect(result.blocked.map(b => b.ip)).toEqual(['2.2.2.2']);
  });
});

describe('escalation helpers', () => {
  it('resolveBlockDurationMs clamps to the last step', () => {
    expect(resolveBlockDurationMs(0, [1, 2, 3])).toBe(1);
    expect(resolveBlockDurationMs(2, [1, 2, 3])).toBe(3);
    expect(resolveBlockDurationMs(99, [1, 2, 3])).toBe(3);
  });

  it.each(['', '   ', 'abc', '10,0', '10,,60', '-5', '1.5'])('falls back to the default schedule for %j', raw => {
    expect(parseEscalationMinutes(raw)).toEqual([10, 60, 1440]);
  });

  it('parses a valid schedule', () => {
    expect(parseEscalationMinutes('5, 30,120')).toEqual([5, 30, 120]);
  });
});
