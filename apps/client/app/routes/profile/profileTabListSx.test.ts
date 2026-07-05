import { describe, expect, it } from 'vitest';
import { profileTabListSx } from './profileTabListSx';

// Value guard for the profile tab strip layout constants. jsdom's getComputedStyle
// does not resolve MUI Joy's `calc(... * var(--joy-spacing))` and does not lay out
// flex overflow, so the rendered gap and overlap can't be asserted here; this only
// locks the constants (gap, flexWrap: nowrap, overflowX: auto, per-tab flexShrink: 0)
// against regressing. Visual whitespace / no overlap is verified by QA on preview.
describe('profileTabListSx (Bug A)', () => {
  it('uses a theme spacing gap, not a near-zero pixel value', () => {
    expect(profileTabListSx.gap).toBe(1);
  });

  it('does not regress to the original 2px gap', () => {
    expect(profileTabListSx.gap).not.toBe('2px');
  });

  it('keeps the strip on one row and lets it scroll instead of wrapping', () => {
    expect(profileTabListSx.flexWrap).toBe('nowrap');
    expect(profileTabListSx.overflowX).toBe('auto');
  });

  it('prevents tabs from shrinking below their content width', () => {
    expect(profileTabListSx['& .MuiTab-root'].flexShrink).toBe(0);
  });
});
