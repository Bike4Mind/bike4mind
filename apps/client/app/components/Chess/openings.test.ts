import { describe, it, expect } from 'vitest';
import { getOpeningName } from './openings';

describe('getOpeningName', () => {
  it('returns "Starting Position" for an empty move list', () => {
    expect(getOpeningName([])).toBe('Starting Position');
  });

  it('identifies common King\u2019s Pawn openings', () => {
    expect(getOpeningName(['e4'])).toBe('King\u2019s Pawn Opening');
    expect(getOpeningName(['e4', 'e5'])).toBe('Open Game');
    expect(getOpeningName(['e4', 'e5', 'Nf3'])).toBe('King\u2019s Knight Opening');
  });

  it('identifies the Italian Game and Ruy Lopez at move 3', () => {
    expect(getOpeningName(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'])).toBe('Italian Game');
    expect(getOpeningName(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])).toBe('Ruy Lopez');
  });

  it('uses longest-prefix matching to prefer specific lines over catch-alls', () => {
    // 1.e4 c5 alone is "Sicilian Defense"; the deeper Najdorf must override.
    expect(
      getOpeningName(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'])
    ).toBe('Sicilian Najdorf');
    // The Dragon variation only diverges at move 5.
    expect(
      getOpeningName(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'g6'])
    ).toBe('Sicilian Dragon');
  });

  it('identifies Queen\u2019s Pawn lines', () => {
    expect(getOpeningName(['d4'])).toBe('Queen\u2019s Pawn Opening');
    expect(getOpeningName(['d4', 'd5', 'c4'])).toBe('Queen\u2019s Gambit');
    expect(getOpeningName(['d4', 'd5', 'c4', 'dxc4'])).toBe('Queen\u2019s Gambit Accepted');
    expect(getOpeningName(['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'])).toBe('Nimzo-Indian Defense');
  });

  it('identifies flank openings', () => {
    expect(getOpeningName(['c4'])).toBe('English Opening');
    expect(getOpeningName(['Nf3'])).toBe('R\u00E9ti Opening');
    expect(getOpeningName(['f4'])).toBe('Bird\u2019s Opening');
  });

  it('returns "Unknown Opening" for genuinely unknown move sequences', () => {
    // Real moves but not in our table - Sokolsky / Polish Opening.
    expect(getOpeningName(['b4'])).toBe('Unknown Opening');
  });

  it('still returns the deepest match if extra moves follow', () => {
    // Italian Game continues into Giuoco Piano; we don't track Giuoco, so we
    // should keep the Italian Game label rather than fall back to a shallower
    // pattern.
    expect(getOpeningName(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'])).toBe('Italian Game');
  });
});
