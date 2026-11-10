import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({ Logger: logger }));

const load = async (verbose: string | undefined) => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_VERBOSE_IMAGES', verbose as string);
  return (await import('./imageLogger')).imageLogger;
};

describe('imageLogger', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it('always sends errors to the Logger, even when verbose logging is off', async () => {
    const log = await load('false');
    const failure = new Error('boom');

    log.error('render failed', failure);

    expect(logger.error).toHaveBeenCalledWith('render failed', failure);
  });

  it('is silent for log, info, warn, debug and timers when verbose logging is off', async () => {
    const log = await load('false');

    log.log('a');
    log.info('b');
    log.warn('c');
    log.debug('d');
    log.group('g');
    log.time('t');
    log.timeEnd('t');

    expect(log.isEnabled()).toBe(false);
    for (const fn of Object.values(logger)) expect(fn).not.toHaveBeenCalled();
  });

  it('routes verbose output through the matching Logger level', async () => {
    const log = await load('true');

    log.log('a');
    log.info('b');
    log.warn('c');
    log.debug('d');

    expect(logger.info).toHaveBeenCalledWith('a');
    expect(logger.info).toHaveBeenCalledWith('b');
    expect(logger.warn).toHaveBeenCalledWith('c');
    expect(logger.debug).toHaveBeenCalledWith('d');
  });

  it('logs the elapsed time of a timer as durationMs', async () => {
    const log = await load('true');

    log.time('render');
    log.timeEnd('render');
    log.timeEnd('never-started');

    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith('render', { durationMs: expect.any(Number) });
  });
});
