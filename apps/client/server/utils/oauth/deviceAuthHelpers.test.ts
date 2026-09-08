import { describe, it, expect, vi } from 'vitest';
import { generateUserCode } from './deviceAuthHelpers';

describe('generateUserCode', () => {
  it('matches the XXXX-XXXX format over the confusion-free charset', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateUserCode()).toMatch(
        /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/
      );
    }
  });

  it('uses a CSPRNG, never the predictable Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    generateUserCode();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
