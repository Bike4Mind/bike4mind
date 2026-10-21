import { describe, expect, it } from 'vitest';
import { chatActionButtonSx, TOUCH_TARGET_QUERY } from './chatActionButtonSx';

describe('chatActionButtonSx', () => {
  it('keeps the 24px frame on desktop', () => {
    expect(chatActionButtonSx.minWidth).toBe('24px');
    expect(chatActionButtonSx.minHeight).toBe('24px');
  });

  it('grows the hit area to 44px on narrow or touch screens without enlarging the glyph', () => {
    const touch = chatActionButtonSx[TOUCH_TARGET_QUERY];
    expect(touch.minWidth).toBe('44px');
    expect(touch.minHeight).toBe('44px');
    expect(touch['--IconButton-size']).toBe('44px');
    expect(chatActionButtonSx['--Icon-fontSize']).toBe('16px');
    expect(TOUCH_TARGET_QUERY).toContain('639.95px');
    expect(TOUCH_TARGET_QUERY).toContain('pointer: coarse');
  });
});
