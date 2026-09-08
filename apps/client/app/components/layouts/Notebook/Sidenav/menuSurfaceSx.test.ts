import { describe, it, expect } from 'vitest';
import { extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { menuListSx, menuRowSx, menuSurfaceSx, selectListboxSx } from './menuSurfaceSx';

const theme = extendTheme({ ...getThemeConfig() });

describe('menuSurfaceSx', () => {
  it('defaults to the 8px corner the panels and menus share', () => {
    expect(menuSurfaceSx(theme).borderRadius).toBe('8px');
  });

  it('takes the corner as an argument, for the profile More flyout', () => {
    expect(menuSurfaceSx(theme, '12px').borderRadius).toBe('12px');
  });
});

describe('menuListSx', () => {
  // Joy derives --ListItem-radius from --List-radius and --List-padding (8/8 comes out at 4px),
  // so leaving it unpinned is what made menus disagree about their row corners.
  it('pins the row corner rather than letting Joy derive a smaller one', () => {
    expect(menuListSx()['--ListItem-radius']).toBe('8px');
    expect(menuListSx()['--List-radius']).toBe('8px');
    expect(menuListSx()['--List-padding']).toBe('8px');
  });

  it('spaces a Select listbox at 4px and takes a denser gap for action menus', () => {
    expect(menuListSx()['--List-gap']).toBe('4px');
    expect(menuListSx({ gap: '2px' })['--List-gap']).toBe('2px');
  });

  it('carries the app scrollbar so a long menu does not fall back to the platform bar', () => {
    expect(Object.keys(menuListSx())).toContain('&::-webkit-scrollbar-thumb');
  });

  // The surface pads with the same constant, so content sits the same distance from the edge
  // whether the surface is a List or a plain Box. Two independent literals could drift.
  it('insets the list by the same amount the surface pads with', () => {
    expect(menuListSx()['--List-padding']).toBe(menuSurfaceSx(theme).p);
  });
});

describe('selectListboxSx', () => {
  const optionSx = selectListboxSx(theme)['& [role="option"]'];

  it('keeps the list tokens it layers on', () => {
    expect(selectListboxSx(theme)['--List-gap']).toBe('4px');
    expect(selectListboxSx(theme, { gap: '2px' })['--List-gap']).toBe('2px');
  });

  it('routes hover and press through the variables Joy actually paints from', () => {
    expect(optionSx['--variant-plainHoverBg']).toBe(theme.palette.notebooklist.hoverBg);
    expect(optionSx['--variant-plainActiveBg']).toBe(theme.palette.notebooklist.hoverBg);
  });

  it('marks the selected row by its ground and leaves the text as ordinary ink', () => {
    expect(optionSx['&[aria-selected="true"]']).toMatchObject({
      backgroundColor: theme.palette.notebooklist.focusedBackground,
      color: 'inherit',
    });
  });

  it('styles option rows only, so it is inert on a Joy Menu (rows are role="menuitem")', () => {
    const roleSelectors = Object.keys(selectListboxSx(theme)).filter(key => key.includes('role='));
    expect(roleSelectors).toEqual(['& [role="option"]']);
  });
});

describe('menuRowSx', () => {
  // Joy's ListItemButton carries an unconditional `&:active` painted from --variant-plainActiveBg.
  // Unset, it falls through to neutral.plainActiveBg, which this theme tints brand blue, so a
  // Joy-backed row flashes blue under the finger.
  it('pins the press ground rather than letting Joy fall through to the brand tint', () => {
    expect(menuRowSx(theme)['--variant-plainActiveBg']).toBe(theme.palette.notebooklist.hoverBg);
    expect(menuRowSx(theme)['--variant-plainActiveBg']).not.toBe(theme.palette.neutral.plainActiveBg);
  });

  it('keeps press on the hover ground rather than introducing a third colour', () => {
    expect(menuRowSx(theme)['--variant-plainActiveBg']).toBe(menuRowSx(theme)['&:hover'].backgroundColor);
    expect(menuRowSx(theme, true)['--variant-plainActiveBg']).toBe(menuRowSx(theme, true)['&:hover'].backgroundColor);
  });

  // The recipe sets the variables itself, so a Joy MenuItem consumer does not have to restate
  // them - that restatement is what let the destructive row and the plain rows drift.
  it('carries the danger ground on the declaration and both variables alike', () => {
    const dangerRow = menuRowSx(theme, true);
    expect(dangerRow['--variant-plainHoverBg']).toBe(theme.palette.danger.plainHoverBg);
    expect(dangerRow['--variant-plainActiveBg']).toBe(theme.palette.danger.plainHoverBg);
    expect(dangerRow['&:hover'].backgroundColor).toBe(theme.palette.danger.plainHoverBg);
  });
});
