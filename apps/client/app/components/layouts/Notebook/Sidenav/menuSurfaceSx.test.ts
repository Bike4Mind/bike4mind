import { describe, it, expect } from 'vitest';
import { extendTheme } from '@mui/joy/styles';
import menuItemClasses from '@mui/joy/MenuItem/menuItemClasses';
import { getThemeConfig } from '@client/app/utils/themes';
import { menuItemListSx, menuListSx, menuRowSx, menuSurfaceSx, selectListboxSx } from './menuSurfaceSx';

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

describe('menuItemListSx', () => {
  const rowSx = menuItemListSx(theme)['& [role="menuitem"]'];

  it('keeps the list tokens it layers on', () => {
    expect(menuItemListSx(theme)['--List-gap']).toBe('4px');
    expect(menuItemListSx(theme, { gap: '2px' })['--List-gap']).toBe('2px');
  });

  it('routes hover and press through the variables Joy actually paints from', () => {
    expect(rowSx['--variant-plainHoverBg']).toBe(theme.palette.notebooklist.hoverBg);
    expect(rowSx['--variant-plainActiveBg']).toBe(theme.palette.notebooklist.hoverBg);
  });

  // Joy paints .Mui-selected from the plainActive variant too, so the selected ground has to be a
  // declaration - through the variable it would collapse onto the hover ground.
  it('marks the selected row by its own ground, not by the press variable', () => {
    expect(rowSx[`&.${menuItemClasses.selected}`]).toMatchObject({
      backgroundColor: theme.palette.notebooklist.focusedBackground,
    });
  });

  // The ground alone is NOT enough: dark mode gives hoverBg and focusedBackground the same value,
  // so a hovered sibling paints the selected row's exact colour and only the weight still marks
  // it. Asserted per scheme because `theme.palette` resolves to the light one, where the two
  // tokens happen to differ - which is how a light-only assertion hid this.
  describe.each(['light', 'dark'] as const)('in the %s scheme', scheme => {
    const palette = theme.colorSchemes[scheme].palette;
    const schemeRowSx = menuItemListSx({ ...theme, palette } as typeof theme)['& [role="menuitem"]'];
    const selected = schemeRowSx[`&.${menuItemClasses.selected}`];

    it('keeps the selected row distinguishable from a hovered sibling', () => {
      const groundAlone = selected.backgroundColor !== schemeRowSx['--variant-plainHoverBg'];
      expect(groundAlone || selected.fontWeight === 600).toBe(true);
    });

    it('routes hover and press at the menu ground for that scheme', () => {
      expect(schemeRowSx['--variant-plainHoverBg']).toBe(palette.notebooklist.hoverBg);
      expect(schemeRowSx['--variant-plainActiveBg']).toBe(palette.notebooklist.hoverBg);
    });
  });

  // The two-line lake picker rows are the reason this exists rather than menuRowSx: a fixed
  // height, padding or gap here would crop them.
  it('sets no row geometry, so a two-line row with a decorator and a count still fits', () => {
    expect(Object.keys(rowSx)).not.toContain('height');
    expect(Object.keys(rowSx)).not.toContain('px');
    expect(Object.keys(rowSx)).not.toContain('gap');
  });

  it('styles menuitem rows only, so it is inert on a Select listbox (rows are role="option")', () => {
    const roleSelectors = Object.keys(menuItemListSx(theme)).filter(key => key.includes('role='));
    expect(roleSelectors).toEqual(['& [role="menuitem"]']);
  });
});

describe('menuRowSx', () => {
  // Joy's ListItemButton carries an unconditional `&:active` painted from --variant-plainActiveBg.
  // Unset, it falls through to neutral.plainActiveBg, which this theme tints brand blue, so a
  // Joy-backed row flashes blue under the finger.
  // Both schemes: neutral.plainActiveBg is brand[100] in light and brand[700] in dark, and the
  // fall-through was visible in both.
  it.each(['light', 'dark'] as const)(
    'pins the press ground rather than letting Joy fall through to the %s brand tint',
    scheme => {
      const palette = theme.colorSchemes[scheme].palette;
      const row = menuRowSx({ ...theme, palette } as typeof theme);
      expect(row['--variant-plainActiveBg']).toBe(palette.notebooklist.hoverBg);
      expect(row['--variant-plainActiveBg']).not.toBe(palette.neutral.plainActiveBg);
    }
  );

  it('keeps press on the hover ground rather than introducing a third colour', () => {
    expect(menuRowSx(theme)['--variant-plainActiveBg']).toBe(menuRowSx(theme)['&:hover'].backgroundColor);
    expect(menuRowSx(theme, true)['--variant-plainActiveBg']).toBe(menuRowSx(theme, true)['&:hover'].backgroundColor);
  });

  // The recipe sets the variables itself, so a Joy MenuItem consumer does not have to restate
  // them - that restatement is what let the destructive row and the plain rows drift.
  it('carries the danger ground on both variables, not just the hover declaration', () => {
    const dangerRow = menuRowSx(theme, true);
    expect(dangerRow['--variant-plainHoverBg']).toBe(theme.palette.danger.plainHoverBg);
    expect(dangerRow['--variant-plainActiveBg']).toBe(theme.palette.danger.plainHoverBg);
  });

  // Both halves of the menuitem recipe sit on the same ground, so a plain row marks a press the
  // same way whichever one styles it.
  it('agrees with menuItemListSx on the press ground', () => {
    expect(menuRowSx(theme)['--variant-plainActiveBg']).toBe(
      menuItemListSx(theme)['& [role="menuitem"]']['--variant-plainActiveBg']
    );
  });
});
