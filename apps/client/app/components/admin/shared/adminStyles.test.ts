import { describe, expect, it } from 'vitest';
import { ADMIN_FRAME_MIN_PB, adminPageFrame } from './adminStyles';

describe('adminPageFrame', () => {
  it('keeps enough bottom padding on every breakpoint for the AI chat pill to clear the table pager', () => {
    // FloatingChatPill sits 20 px in from the bottom-right corner and is 40 px tall, so anything in the
    // last 60 px of the page is under it. The DataTable footer puts 8 px under its pager buttons, so the
    // frame needs (60 - 8) / 8 = 6.5 units, rounded up to 7.
    expect(ADMIN_FRAME_MIN_PB).toBe(7);
    for (const [breakpoint, units] of Object.entries(adminPageFrame.pb)) {
      expect(units, breakpoint).toBeGreaterThanOrEqual(ADMIN_FRAME_MIN_PB);
    }
  });
});
