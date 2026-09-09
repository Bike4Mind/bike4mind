import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import menuItemClasses from '@mui/joy/MenuItem/menuItemClasses';
import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import { getThemeConfig } from '@client/app/utils/themes';
import {
  MENU_ROW_RADIUS,
  menuItemListSx,
  menuListSx,
  menuRowSx,
  menuSurfaceSx,
  selectListboxSx,
} from './menuSurfaceSx';

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

  // Both sides read MENU_INSET, so this cannot fail while they keep doing so - that is the
  // point. It guards against either SITE reverting to a hardcoded literal and the surface's
  // padding drifting from the list's inset again, not against two independent values disagreeing.
  it('insets the list by the same amount the surface pads with', () => {
    expect(menuListSx()['--List-padding']).toBe(menuSurfaceSx(theme).p);
  });

  // --List-radius is not inert: Joy paints a visible corner from it (Menu.js:51, Select.js:240,
  // List.js:130), so a caller giving menuSurfaceSx a 12px corner must be able to say so here too
  // rather than leaving the element declaring 12px in sx and 8px in the variable.
  it('takes the surface corner, so the two cannot declare different corners for one element', () => {
    expect(menuListSx()['--List-radius']).toBe(menuSurfaceSx(theme).borderRadius);
    expect(menuListSx({ radius: '12px' })['--List-radius']).toBe('12px');
  });

  // The surface's corner and the row's corner are separate on purpose: a 12px panel still wants
  // 8px rows, exactly as the profile menu's More flyout does.
  it('leaves the row corner alone when the surface corner changes', () => {
    expect(menuListSx({ radius: '12px' })['--ListItem-radius']).toBe(MENU_ROW_RADIUS);
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

  // An Option is a StyledListItemButton, whose `borderRadius: var(--ListItem-radius)`
  // (ListItemButton.js:83) already takes the corner menuListSx pins - a second literal here was
  // one more place for the row corner to drift.
  it('leaves the option corner to --ListItem-radius rather than declaring its own', () => {
    expect(optionSx).not.toHaveProperty('borderRadius');
    expect(selectListboxSx(theme)['--ListItem-radius']).toBe(MENU_ROW_RADIUS);
  });

  it('passes the surface corner through to the list tokens it layers on', () => {
    expect(selectListboxSx(theme, { radius: '12px' })['--List-radius']).toBe('12px');
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

  it('passes the surface corner through to the list tokens it layers on', () => {
    expect(menuItemListSx(theme, { radius: '12px' })['--List-radius']).toBe('12px');
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

  // menuRowSx's literal is load-bearing where --ListItem-radius never resolves: ProfileMenu
  // applies it to plain Boxes. It still has to be the SAME corner as the Joy-backed rows.
  it('gives a plain Box row the same corner Joy-backed rows get from the variable', () => {
    expect(menuRowSx(theme).borderRadius).toBe(MENU_ROW_RADIUS);
    expect(menuListSx()['--ListItem-radius']).toBe(MENU_ROW_RADIUS);
  });
});

/**
 * The recipes' strongest claim is a CASCADE claim - that our selected-row declaration outranks
 * the rule Joy paints the same row from - and no assertion on a returned object can see it.
 *
 * What jsdom does resolve here is the cascade over Emotion's real stylesheet, so a rule losing
 * its specificity race shows up as a changed computed value. What it does NOT resolve is `var()`,
 * so Joy's own painting reads back as the literal `var(--variant-plainActiveBg, ...)` string -
 * which is exactly what makes it legible as "Joy won, we did not". Corners are var()-driven the
 * whole way down, so a corner assertion here can only show WHICH rule computes, and is paired
 * with a token assertion for the value that rule reads.
 */
const SelectHarness = ({ sx }: { sx: object }) => (
  <CssVarsProvider theme={theme}>
    <Select defaultValue="b" defaultListboxOpen slotProps={{ listbox: { sx } }}>
      <Option value="a">Option A</Option>
      <Option value="b">Option B</Option>
    </Select>
  </CssVarsProvider>
);

const MenuHarness = ({ sx }: { sx: object }) => (
  <CssVarsProvider theme={theme}>
    <Dropdown open>
      <MenuButton>Trigger</MenuButton>
      <Menu sx={sx}>
        <MenuItem data-testid="row-plain">Plain</MenuItem>
        <MenuItem selected data-testid="row-selected">
          Selected
        </MenuItem>
      </Menu>
    </Dropdown>
  </CssVarsProvider>
);

const bg = (el: Element) => getComputedStyle(el).backgroundColor;
const selectedGround = theme.palette.notebooklist.focusedBackground;

describe('selectListboxSx on a rendered Joy Select', () => {
  it('paints the selected option itself, outranking the rule Joy paints it from', () => {
    render(<SelectHarness sx={(t: typeof theme) => ({ ...menuSurfaceSx(t), ...selectListboxSx(t) })} />);
    const selected = screen.getAllByRole('option').find(o => o.getAttribute('aria-selected') === 'true');
    expect(selected).toBeDefined();
    // Joy's own `.Mui-selected` rule (ListItemButton.js:99) is live on this element and paints
    // from --variant-plainActiveBg, which this recipe points at the HOVER ground. Reading back
    // the hover ground, or an unresolved var(), would mean the selected row stopped being marked.
    expect(bg(selected as Element)).toBe(selectedGround);
  });

  // Completes the argument for dropping this recipe's own `borderRadius`: Joy's rule is the one
  // that computes, and menuListSx pins the variable it reads. jsdom does not substitute var(),
  // which is why the unresolved form is accepted here alongside the value it resolves to.
  it('takes the option corner from Joy reading --ListItem-radius, which menuListSx pins', () => {
    render(<SelectHarness sx={(t: typeof theme) => ({ ...menuSurfaceSx(t), ...selectListboxSx(t) })} />);
    const option = screen.getAllByRole('option')[0];
    expect(['var(--ListItem-radius)', MENU_ROW_RADIUS]).toContain(getComputedStyle(option).borderRadius);
    expect(selectListboxSx(theme)['--ListItem-radius']).toBe(MENU_ROW_RADIUS);
  });

  it('leaves an unselected option to Joy, so the mark means something', () => {
    render(<SelectHarness sx={(t: typeof theme) => ({ ...menuSurfaceSx(t), ...selectListboxSx(t) })} />);
    const unselected = screen.getAllByRole('option').find(o => o.getAttribute('aria-selected') !== 'true');
    expect(bg(unselected as Element)).not.toBe(selectedGround);
  });
});

describe('the two row recipes on a rendered Joy Menu', () => {
  // The object-level version of this filtered returned keys for `role=` and asserted one entry,
  // which would still pass if selectListboxSx grew a `'& .MuiMenuItem-root': {...}` key - very
  // much not inert. This renders the thing and looks at the row.
  // BOTH rows, and the plain one is the load-bearing half: Joy's own `.Mui-selected` rule happens
  // to outrank a stray low-specificity leak on the selected row, so checking only that row would
  // pass while every OTHER row in the menu had been repainted.
  it('selectListboxSx is inert: a Joy Menu row takes none of the option styling', () => {
    render(<MenuHarness sx={(t: typeof theme) => ({ ...menuSurfaceSx(t), ...selectListboxSx(t) })} />);
    expect(bg(screen.getByTestId('row-plain'))).not.toBe(selectedGround);
    expect(bg(screen.getByTestId('row-selected'))).not.toBe(selectedGround);
  });

  // The contrast is what gives the assertion above its teeth: the same harness, the same ground,
  // the [role="menuitem"] recipe instead - and now the row IS painted. Without this, "not the
  // selected ground" would pass just as well if the Menu had failed to render at all.
  it('menuItemListSx is the one that reaches those rows', () => {
    render(<MenuHarness sx={(t: typeof theme) => ({ ...menuSurfaceSx(t), ...menuItemListSx(t) })} />);
    expect(bg(screen.getByTestId('row-selected'))).toBe(selectedGround);
    expect(bg(screen.getByTestId('row-plain'))).not.toBe(selectedGround);
  });
});
