import { describe, it, expect, vi } from 'vitest';
import { usableSessionIds } from './objectIds';

const GOOD = '507f1f77bcf86cd799439011';
const JUNK = 'legacy-uuid-not-an-objectid';

describe('usableSessionIds', () => {
  const logger = () => ({ warn: vi.fn() });

  it('keeps only the ids that can address a row by _id', () => {
    expect(usableSessionIds([GOOD, JUNK, '0123456789ab'], 'knowledge', logger())).toEqual([GOOD]);
  });

  it('accepts uppercase hex, which is a valid ObjectId rendering', () => {
    const upper = GOOD.toUpperCase();
    expect(usableSessionIds([upper], 'knowledge', logger())).toEqual([upper]);
  });

  it('names what it dropped, so a partial result never reads as a complete one', () => {
    const log = logger();
    usableSessionIds([GOOD, JUNK], 'knowledge', log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('[knowledge]'), { skipped: [JUNK] });
  });

  it.each(['tool', 'agent'] as const)('names the %s kind in its warning', kind => {
    const log = logger();
    usableSessionIds([JUNK], kind, log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`[${kind}]`), { skipped: [JUNK] });
  });

  it('stays quiet when every id is usable', () => {
    const log = logger();
    usableSessionIds([GOOD], 'knowledge', log);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('stays quiet on an empty list rather than reporting an empty skip', () => {
    const log = logger();
    expect(usableSessionIds([], 'knowledge', log)).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
