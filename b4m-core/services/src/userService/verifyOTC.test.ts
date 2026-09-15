import { describe, it, expect } from 'vitest';
import { verifyPendingOTC } from './verifyOTC';
import bcrypt from 'bcryptjs';

describe('verifyPendingOTC', () => {
  it('returns true for matching code', async () => {
    const hash = await bcrypt.hash('654321', 10);
    expect(await verifyPendingOTC('654321', hash)).toBe(true);
  });

  it('returns false for wrong code', async () => {
    const hash = await bcrypt.hash('654321', 10);
    expect(await verifyPendingOTC('000000', hash)).toBe(false);
  });

  it('returns false for empty/invalid input instead of throwing', async () => {
    const hash = await bcrypt.hash('654321', 10);
    expect(await verifyPendingOTC('', hash)).toBe(false);
    expect(await verifyPendingOTC('654321', '')).toBe(false);
    // @ts-expect-error - exercising the runtime guard against non-string input
    expect(await verifyPendingOTC(undefined, hash)).toBe(false);
  });
});
