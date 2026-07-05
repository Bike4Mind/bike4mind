import { describe, it, expect } from 'vitest';
import { BFL_SAFETY_TOLERANCE, FluxProInputSchema } from '../schemas/bfl';

describe('BFL safety_tolerance hard cap (#9776)', () => {
  it('hard-caps the maximum at 2 (BFL scale: 0=strict, 6=unfiltered)', () => {
    expect(BFL_SAFETY_TOLERANCE.MAX).toBe(2);
  });

  it('defaults within the hard cap', () => {
    expect(BFL_SAFETY_TOLERANCE.DEFAULT).toBeLessThanOrEqual(BFL_SAFETY_TOLERANCE.MAX);
  });

  it('clamps legacy stored values (3-6) down to the cap instead of rejecting them', () => {
    // Sessions saved before the cap may carry safety_tolerance up to 6 in their
    // settings - parsing must coerce, not fail, or image generation breaks for them.
    const parsed = FluxProInputSchema.parse({ safety_tolerance: 6 });
    expect(parsed.safety_tolerance).toBe(BFL_SAFETY_TOLERANCE.MAX);
  });

  it('fills the default when safety_tolerance is omitted', () => {
    const parsed = FluxProInputSchema.parse({});
    expect(parsed.safety_tolerance).toBe(BFL_SAFETY_TOLERANCE.DEFAULT);
  });

  it('keeps in-cap values unchanged', () => {
    const parsed = FluxProInputSchema.parse({ safety_tolerance: 1 });
    expect(parsed.safety_tolerance).toBe(1);
  });

  it('still rejects values outside the legacy 0-6 input range', () => {
    expect(() => FluxProInputSchema.parse({ safety_tolerance: 7 })).toThrow();
    expect(() => FluxProInputSchema.parse({ safety_tolerance: -1 })).toThrow();
  });
});
