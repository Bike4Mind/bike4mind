import { describe, expect, it } from 'vitest';
import { extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SIDENAV } from './metrics';
import {
  conversationRowSx,
  iconSlotSx,
  listRowsSx,
  navRowSx,
  navStackSx,
  notebookListTokens,
  pinnedSx,
  searchBarSx,
  sectionSx,
  sidenavTokens,
} from './styles';

// extendTheme returns the CSS-vars theme; its `palette` is the default scheme's, which is what the
// sx callbacks read at runtime.
const theme = extendTheme({ ...getThemeConfig() }) as unknown as Parameters<typeof navRowSx>[0];

describe('sidenav kit styles', () => {
  it('reads the host palette keys and answers {} when they are missing', () => {
    expect(sidenavTokens(theme)).toHaveProperty('pinnedBackdrop');
    expect(notebookListTokens(theme)).toHaveProperty('hoverBg');
    const bare = { ...theme, palette: { ...theme.palette, sidenav: undefined, notebooklist: undefined } };
    expect(sidenavTokens(bare as typeof theme)).toEqual({});
    expect(notebookListTokens(bare as typeof theme)).toEqual({});
  });

  it('builds the nav row from the metrics', () => {
    const row = navRowSx(theme, false);
    expect(row.height).toBe('32px');
    expect(row.borderRadius).toBe(SIDENAV.rowRadius);
    expect(row.px).toBe('12px');
  });

  it('paints the focused wash only on the active row', () => {
    const list = notebookListTokens(theme);
    expect(navRowSx(theme, true).backgroundColor).toBe(list.focusedBackground);
    expect(navRowSx(theme, false).backgroundColor).toBe('transparent');
  });

  it('sets the Joy icon variable on the icon slot', () => {
    expect(iconSlotSx(theme)['--Icon-color']).toBe(sidenavTokens(theme).navItemIcon);
  });

  it('draws the conversation frame: radius, selected bar only when selected', () => {
    expect(conversationRowSx(theme, false).borderRadius).toBe(SIDENAV.rowRadius);
    expect(conversationRowSx(theme, true)['&::before']).toMatchObject({ width: '2px' });
    expect(conversationRowSx(theme, false)['&::before']).toEqual({});
  });

  it('spaces blocks and rows from the metrics', () => {
    expect(pinnedSx(theme)).toMatchObject({ position: 'sticky', top: 0, pt: '10px' });
    expect(sectionSx).not.toHaveProperty('mt');
    expect(navStackSx).toMatchObject({ display: 'flex', flexDirection: 'column', gap: '2px', mt: '2px' });
    expect(searchBarSx(theme, 78)).toMatchObject({ position: 'sticky', top: '78px', pt: '6px', pb: '10px' });
    expect(listRowsSx).toMatchObject({ display: 'flex', flexDirection: 'column', gap: '2px' });
  });
});
