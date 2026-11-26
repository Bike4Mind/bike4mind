import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Box,
  Button,
  Card,
  FormControl,
  Input,
  Modal,
  ModalDialog,
  Select,
  Sheet,
  Textarea,
  Typography,
} from '@mui/joy';
import type { Components, Theme } from '@mui/joy/styles';
import { adminFocusScope } from '@client/app/components/admin/shared/adminStyles';
import AppTheme from '../AppTheme';
import {
  IN_ADMIN,
  IN_ADMIN_POPUP,
  IN_ADMIN_PORTAL,
  IN_ADMIN_ROW,
  IN_ADMIN_TOOLTIP,
  adminSkinComponents,
  withAdminSkin,
} from './adminSkin';

const radiusOf = (testId: string) => getComputedStyle(screen.getByTestId(testId)).borderRadius;

describe('admin skin scope', () => {
  it('styles components under data-admin-surface and leaves the rest of the app unchanged', () => {
    render(
      <AppTheme>
        <Card data-testid="outside-card">outside</Card>
        <Button data-testid="outside-btn">outside</Button>
        <Sheet data-admin-surface data-testid="admin-root">
          <Card data-testid="admin-card">inside</Card>
        </Sheet>
      </AppTheme>
    );

    expect(radiusOf('admin-card')).toBe('12px');
    expect(radiusOf('outside-card')).not.toBe('12px');
    // Buttons read their fill through Joy's palette variables, which the admin root remaps to ink.
    const solidBg = (testId: string) =>
      getComputedStyle(screen.getByTestId(testId)).getPropertyValue('--joy-palette-primary-solidBg').trim();
    expect(solidBg('admin-root')).toBe('var(--joy-palette-admin-ink)');
    expect(solidBg('outside-btn')).not.toBe('var(--joy-palette-admin-ink)');
  });

  // The skin colors body-sm through a var rather than `color`, so white text on a colored strip survives inside the scope.
  it('keeps a flat sx color on body-sm text', () => {
    render(
      <AppTheme>
        <Sheet data-admin-surface>
          <Box sx={{ backgroundColor: 'rgb(0, 128, 0)' }}>
            <Typography data-testid="banner-title" level="body-sm" sx={{ color: 'white' }}>
              Local Development
            </Typography>
          </Box>
          <Typography data-testid="cell-text" level="body-sm">
            cell
          </Typography>
        </Sheet>
      </AppTheme>
    );

    expect(getComputedStyle(screen.getByTestId('banner-title')).color).toBe('rgb(255, 255, 255)');
    expect(
      getComputedStyle(screen.getByTestId('cell-text')).getPropertyValue('--joy-palette-text-tertiary').trim()
    ).toBe('var(--joy-palette-admin-inkSecondary)');
  });

  it.each([
    ['while an admin surface is mounted', true, '16px'],
    ['on a non-admin page', false, undefined],
  ])('skins portalled dialogs only %s', (_label, adminMounted, expected) => {
    render(
      <AppTheme>
        {adminMounted ? <Sheet data-admin-surface /> : <Sheet />}
        <Modal open>
          <ModalDialog data-testid="dialog">
            <Typography>Body</Typography>
          </ModalDialog>
        </Modal>
      </AppTheme>
    );

    if (expected) expect(radiusOf('dialog')).toBe(expected);
    else expect(radiusOf('dialog')).not.toBe('16px');
  });

  it('scopes every override, so no rule can leak outside the admin', () => {
    const props = { ownerState: { level: 'h2' }, theme: {} };
    const keys = Object.values(adminSkinComponents).flatMap(({ styleOverrides }) =>
      Object.values(styleOverrides).flatMap(slot =>
        Object.keys(typeof slot === 'function' ? (slot as (p: typeof props) => object)(props) : slot)
      )
    );

    expect(keys.length).toBeGreaterThan(0);
    const scopes = [IN_ADMIN, IN_ADMIN_PORTAL, IN_ADMIN_POPUP, IN_ADMIN_TOOLTIP, IN_ADMIN_ROW];
    expect(keys.filter(key => !scopes.includes(key))).toEqual([]);
  });
});

// jsdom cannot resolve the palette variables, so this reads the emitted rule rather than a computed color.
describe('admin field error state', () => {
  /** The border-color the skin emits for this field root when its outlined root also carries `stateClass`. */
  const errorBorderOf = (testId: string, outlinedClass: string, stateClass: string) => {
    const emotionClass = [...screen.getByTestId(testId).classList].find(name => name.startsWith('css-'));
    const rules = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]) as CSSStyleRule[];
    return rules
      .find(
        rule =>
          rule.selectorText?.includes(`.${emotionClass}`) &&
          rule.selectorText.includes(`.${outlinedClass}.${stateClass}`)
      )
      ?.style.getPropertyValue('border-color');
  };

  it('gives a field the danger border from its own error prop', () => {
    render(
      <AppTheme>
        <Sheet data-admin-surface>
          <Input error data-testid="direct" />
        </Sheet>
      </AppTheme>
    );

    expect(screen.getByTestId('direct')).toHaveClass('Mui-error');
    expect(errorBorderOf('direct', 'MuiInput-variantOutlined', 'Mui-error')).toBe('var(--joy-palette-admin-danger)');
  });

  // Joy only turns a field's color to danger from FormControl's error, without Mui-error on the field root.
  it('gives a field the danger border when its FormControl holds the error', () => {
    render(
      <AppTheme>
        <Sheet data-admin-surface>
          <FormControl error>
            <Input data-testid="input-in-control" />
          </FormControl>
          <FormControl error>
            <Select data-testid="select-in-control" />
          </FormControl>
        </Sheet>
      </AppTheme>
    );

    expect(screen.getByTestId('input-in-control')).not.toHaveClass('Mui-error');
    expect(screen.getByTestId('input-in-control')).toHaveClass('MuiInput-colorDanger');
    expect(errorBorderOf('input-in-control', 'MuiInput-variantOutlined', 'MuiInput-colorDanger')).toBe(
      'var(--joy-palette-admin-danger)'
    );
    expect(screen.getByTestId('select-in-control')).toHaveClass('MuiSelect-colorDanger');
    expect(errorBorderOf('select-in-control', 'MuiSelect-variantOutlined', 'MuiSelect-colorDanger')).toBe(
      'var(--joy-palette-admin-danger)'
    );
  });
});

// A field's only focus indicator is the ring on its root; an outline on the native control inside
// draws a second, square box (the outline rule comes from both the skin and `adminFocusScope`).
describe('admin focus ring', () => {
  const outlineOf = (testId: string) => {
    const element = screen.getByTestId(testId);
    element.focus();
    return getComputedStyle(element).outline;
  };

  it.each([
    ['the skin', {}],
    ['adminFocusScope', adminFocusScope],
  ])('from %s outlines controls but not a field or its native control', (_label, scopeSx) => {
    render(
      <AppTheme>
        <Sheet data-admin-surface sx={scopeSx}>
          <Button data-testid="button">Save</Button>
          <Input slotProps={{ input: { 'data-testid': 'input' } }} />
          <Textarea slotProps={{ textarea: { 'data-testid': 'textarea' } }} />
          <Select className="Mui-focusVisible" data-testid="select" />
        </Sheet>
      </AppTheme>
    );

    expect(outlineOf('button')).toContain('var(--joy-palette-admin-accent)');
    for (const field of ['input', 'textarea', 'select']) {
      expect(outlineOf(field)).not.toContain('var(--joy-palette-admin-accent)');
    }
  });
});

describe('withAdminSkin', () => {
  it('keeps the base overrides it merges into, whether objects or functions', () => {
    const base = {
      JoyCard: { defaultProps: { variant: 'soft' }, styleOverrides: { root: { color: 'red' } } },
      JoyTooltip: { styleOverrides: { root: () => ({ padding: '8px' }) } },
    } as Components<Theme>;
    const merged = withAdminSkin(base) as Record<
      string,
      { defaultProps?: unknown; styleOverrides: Record<string, unknown> }
    >;

    expect(merged.JoyCard.defaultProps).toEqual({ variant: 'soft' });
    expect(merged.JoyCard.styleOverrides.root).toMatchObject({ color: 'red', [IN_ADMIN]: expect.any(Object) });
    const tooltipRoot = merged.JoyTooltip.styleOverrides.root as (props: object) => object;
    expect(tooltipRoot({})).toMatchObject({ padding: '8px', [IN_ADMIN_TOOLTIP]: expect.any(Object) });
  });
});
