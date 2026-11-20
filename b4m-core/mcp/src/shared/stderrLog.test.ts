import { afterEach, describe, expect, it, vi } from 'vitest';
import { stderrLog } from './stderrLog.js';

// Pins the line shape that packages/server-utils mcpCall sniffs for ('"type":"RATE_LIMIT') and
// JSON.parses before posting rate-limit events to the ingest endpoint.
describe('stderrLog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes a rate-limit entry as one parseable JSON line that keeps the ingest fields', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const entry = {
      type: 'RATE_LIMIT_ERROR',
      integration: 'github',
      endpoint: '/repos/o/r/issues',
      limit: 5000,
      remaining: 0,
      resetAt: null,
      retryAfterMs: 1000,
      usagePercent: 100,
      wasThrottled: true,
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    stderrLog('warn', 'github', 'rate_limit', { ...entry });

    expect(write).toHaveBeenCalledTimes(1);
    const line = write.mock.calls[0][0] as string;
    expect(line).toContain('"type":"RATE_LIMIT');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(line)).toMatchObject({
      severity: 'warn',
      scope: 'github',
      msg: 'rate_limit',
      integration: 'github',
      endpoint: '/repos/o/r/issues',
      limit: 5000,
      remaining: 0,
      usagePercent: 100,
      wasThrottled: true,
    });
  });
});
