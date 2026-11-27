import { afterEach, describe, expect, it, vi } from 'vitest';
import { stderrLogger } from './stderrLogger';

describe('stderrLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes every level to console.error and never to stdout-backed console methods', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdout = (['log', 'info', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));

    stderrLogger.debug('d');
    stderrLogger.info('i', { a: 1 });
    stderrLogger.warn('w');
    stderrLogger.error('e', new Error('x'));

    expect(error).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenNthCalledWith(2, 'i', { a: 1 });
    for (const spy of stdout) expect(spy).not.toHaveBeenCalled();
  });
});
