import { describe, it, expect } from 'vitest';
import { BadRequestError } from '@bike4mind/common';
import { rollDice, MAX_DICE_COUNT, MAX_DICE_SIDES } from './dice';

describe('rollDice', () => {
  it('rolls a spec within the total range for the given count/sides', () => {
    for (let i = 0; i < 50; i++) {
      const total = rollDice('3d6');
      expect(total).toBeGreaterThanOrEqual(3); // 3 x min face (1)
      expect(total).toBeLessThanOrEqual(18); // 3 x max face (6)
    }
  });

  it('defaults a bare count to d100 and a bare `NdX` sides to 6', () => {
    const plain = rollDice('1'); // no `d` -> 1 die, 100 sides
    expect(plain).toBeGreaterThanOrEqual(1);
    expect(plain).toBeLessThanOrEqual(100);
    const noSides = rollDice('2d'); // `d` present, sides missing -> 6
    expect(noSides).toBeGreaterThanOrEqual(2);
    expect(noSides).toBeLessThanOrEqual(12);
  });

  it('accepts the exact upper bounds', () => {
    expect(() => rollDice(`${MAX_DICE_COUNT}d2`)).not.toThrow();
    expect(() => rollDice(`1d${MAX_DICE_SIDES}`)).not.toThrow();
  });

  it('rejects an oversized dice count without allocating (the live DoS repro)', () => {
    // Pre-fix, `100000000d6` blocked the shared event loop for ~13s building the rolls array.
    // The bound now throws before the loop, so this returns immediately; if it ever regresses
    // this test blows the vitest timeout instead of hanging CI.
    const start = Date.now();
    expect(() => rollDice('100000000d6')).toThrow(BadRequestError);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('rejects a count one past the cap, and a zero/negative count', () => {
    expect(() => rollDice(`${MAX_DICE_COUNT + 1}d6`)).toThrow(BadRequestError);
    expect(() => rollDice('0d6')).toThrow(BadRequestError);
    expect(() => rollDice('-5d6')).toThrow(BadRequestError);
  });

  it('rejects an oversized or non-integer sides value', () => {
    expect(() => rollDice(`2d${MAX_DICE_SIDES + 1}`)).toThrow(BadRequestError);
    expect(() => rollDice('2d0')).toThrow(BadRequestError);
  });

  it('rejects a non-numeric count rather than silently rolling nothing', () => {
    // `parseInt('abc')` is NaN; pre-fix the loop ran zero times and returned 0, masking the
    // bad input. It is now a loud 400 instead.
    expect(() => rollDice('abcd6')).toThrow(BadRequestError);
  });
});
