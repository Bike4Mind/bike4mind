import { describe, expect, it } from 'vitest';
import { extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { adminBulkBarZIndex, adminPageFrame, adminSaveBarZIndex } from './adminStyles';

describe('sticky bar stacking', () => {
  it('puts the bars above a DataTable sticky header and below Joy popups', () => {
    const theme = extendTheme({ ...getThemeConfig() });
    const { table, popup } = theme.zIndex;
    const bulk = adminBulkBarZIndex(theme);
    const save = adminSaveBarZIndex(theme);
    expect(bulk).toBeGreaterThan(table);
    expect(save).toBeGreaterThan(bulk);
    expect(save).toBeLessThan(popup);
  });
});

describe('adminPageFrame', () => {
  it('keeps enough bottom padding on every breakpoint for the AI chat pill to clear the table pager', () => {
    // FloatingChatPill sits 20 px in from the bottom-right corner and is 40 px tall, so anything in the
    // last 60 px of the page is under it. The DataTable footer puts 8 px under its pager buttons, so the
    // frame needs (60 - 8) / 8 = 6.5 units, rounded up to 7.
    // Smallest frame bottom padding (Joy units of 8 px) that clears the pill.
    expect(adminPageFrame.pb).toBeGreaterThanOrEqual(7);
  });
});
