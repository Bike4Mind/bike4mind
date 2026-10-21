import { describe, expect, it } from 'vitest';
import { isDevLogChord, type ChordInput } from './chord';

const base: ChordInput = { type: 'keyDown', code: 'KeyL', control: false, meta: false, alt: false, shift: false };
const platformModifier: Partial<ChordInput> =
  process.platform === 'darwin' ? { meta: true, alt: true } : { control: true, alt: true };

describe('isDevLogChord', () => {
  it('matches the chord', () => {
    expect(isDevLogChord({ ...base, ...platformModifier })).toBe(true);
  });

  it('ignores key-up, so one press is one toggle', () => {
    expect(isDevLogChord({ ...base, ...platformModifier, type: 'keyUp' })).toBe(false);
  });

  it('needs alt, which is what keeps it clear of the sidebar and session bindings', () => {
    expect(isDevLogChord({ ...base, meta: true, control: true })).toBe(false);
    expect(isDevLogChord({ ...base, ...platformModifier, alt: false })).toBe(false);
  });

  it('does not fire with shift held, or on another key', () => {
    expect(isDevLogChord({ ...base, ...platformModifier, shift: true })).toBe(false);
    expect(isDevLogChord({ ...base, ...platformModifier, code: 'KeyK' })).toBe(false);
  });
});
