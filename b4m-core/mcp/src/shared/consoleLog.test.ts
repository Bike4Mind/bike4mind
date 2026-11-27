import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConsoleLogger } from './consoleLog.js';

describe('createConsoleLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts secret-named fields before calling console.error and console.warn', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createConsoleLogger('x');

    log.error('failed', { token: 'ghp_abcdefghijklmnop', error: new Error('boom') });
    log.warn('slow', { token: 'ghp_abcdefghijklmnop' });

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe('[x] failed');
    expect((error.mock.calls[0][1] as Record<string, unknown>).token).toBe('[REDACTED]');
    expect((warn.mock.calls[0][1] as Record<string, unknown>).token).toBe('[REDACTED]');
  });

  it('redacts secrets embedded in the message text', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    createConsoleLogger('x').error('failed for jane@example.com');

    expect(error.mock.calls[0][0]).not.toContain('jane@example.com');
  });

  it('debug and info do not touch console', () => {
    const spies = (['log', 'info', 'debug', 'warn', 'error'] as const).map(m =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    const log = createConsoleLogger('x');

    log.debug('d');
    log.info('i');

    spies.forEach(s => expect(s).not.toHaveBeenCalled());
  });
});
