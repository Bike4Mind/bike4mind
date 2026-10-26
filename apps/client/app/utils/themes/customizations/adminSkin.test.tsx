import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button, Card, Modal, ModalDialog, Sheet, Typography } from '@mui/joy';
import type { Components, Theme } from '@mui/joy/styles';
import AppTheme from '../AppTheme';
import { IN_ADMIN, IN_ADMIN_PORTAL, IN_ADMIN_ROW, adminSkinComponents, withAdminSkin } from './adminSkin';

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
    expect(keys.filter(key => ![IN_ADMIN, IN_ADMIN_PORTAL, IN_ADMIN_ROW].includes(key))).toEqual([]);
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
    expect(tooltipRoot({})).toMatchObject({ padding: '8px', [IN_ADMIN_PORTAL]: expect.any(Object) });
  });
});
