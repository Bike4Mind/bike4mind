import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStderrLogger, stderrLog } from './stderrLog.js';

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

  it('createStderrLogger writes one scoped JSON line per call and nothing to stdout or console', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createStderrLogger('github');

    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e', { toolName: 'create_issue', status: 500 });

    const lines = write.mock.calls.map(([chunk]) => JSON.parse(chunk as string));
    expect(lines.map(l => l.severity)).toEqual(['debug', 'info', 'warn', 'error']);
    expect(lines[3]).toMatchObject({ scope: 'github', msg: 'e', toolName: 'create_issue', status: 500 });
    expect(stdout).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it('registers a stderr error listener so a closed pipe does not throw', () => {
    expect(process.stderr.listenerCount('error')).toBeGreaterThan(0);
    expect(() => process.stderr.emit('error', new Error('EPIPE'))).not.toThrow();
  });

  it('createStderrLogger redacts secret-named keys and serialises errors', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    createStderrLogger('github').error('failed', { token: 'ghp_abcdefghijklmnop', error: new Error('boom') });

    const line = JSON.parse(write.mock.calls[0][0] as string);
    expect(line.token).toBe('[REDACTED]');
    expect(JSON.stringify(line.error)).toContain('boom');
  });

  it('does not throw on unserializable fields and still writes one parseable line', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const throwing = {
      get boom(): string {
        throw new Error('x');
      },
    };

    expect(() => stderrLog('error', 'x', 'bigint', { n: 1n })).not.toThrow();
    expect(() => stderrLog('error', 'x', 'throwing', throwing)).not.toThrow();

    expect(write).toHaveBeenCalledTimes(2);
    const lines = write.mock.calls.map(([chunk]) => {
      const text = chunk as string;
      expect(text.trimEnd().includes('\n')).toBe(false);
      return JSON.parse(text);
    });
    expect(lines[0]).toMatchObject({ scope: 'x', n: '1' });
    expect(lines[1]).toMatchObject({ scope: 'x', logError: 'unserializable fields' });
  });
});
