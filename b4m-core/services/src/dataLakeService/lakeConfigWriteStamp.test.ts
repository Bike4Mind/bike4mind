import { describe, it, expect } from 'vitest';
import { lakeConfigWriteStamp } from './lakeConfigWriteStamp';

describe('lakeConfigWriteStamp', () => {
  it('records the acting principal', () => {
    expect(lakeConfigWriteStamp({ userId: 'user1' })).toEqual({ lastUpdatedByUserId: 'user1' });
  });

  it('emits NO key for a blank identity rather than an empty string', () => {
    // Spread into an update, an absent key leaves any prior stamp alone; a stored '' would both
    // erase the last attributable write and read downstream as a real principal whose id was lost.
    const stamp = lakeConfigWriteStamp({ userId: '' });
    expect(stamp).toEqual({});
    expect('lastUpdatedByUserId' in stamp).toBe(false);
  });
});
