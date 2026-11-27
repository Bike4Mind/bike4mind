import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({ create: vi.fn(), revoke: vi.fn() }));

vi.mock('@client/app/hooks/data/spaces', () => ({
  useSpaceInviteLinks: () => ({ data: [], isError: false, hasNextPage: false }),
  useCreateSpaceInviteLink: () => ({ mutate: h.create, isPending: false }),
  useRevokeSpaceInviteLink: () => ({ mutateAsync: h.revoke }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));

import SpaceLinksTab, { linkExpiry, MAX_SPACE_LINK_DAYS, SPACE_LINK_EXPIRY_DAYS } from './SpaceLinksTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => vi.clearAllMocks());

describe('Space link form expiry', () => {
  it('never offers more than 90 days', () => {
    expect(Math.max(...SPACE_LINK_EXPIRY_DAYS)).toBe(90);
  });

  it('caps the longest expiry inside 90 days of now', () => {
    const now = Date.now();
    expect(new Date(linkExpiry(500, now)).getTime() - now).toBeLessThanOrEqual(MAX_SPACE_LINK_DAYS * DAY_MS);
    expect(new Date(linkExpiry(90, now)).getTime() - now).toBeLessThan(MAX_SPACE_LINK_DAYS * DAY_MS);
  });

  it('sends the 90 day option as an expiry within the cap, with no permissions', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <SpaceLinksTab spaceId="s1" />
      </CssVarsProvider>
    );
    const before = Date.now();
    fireEvent.click(
      within(screen.getByTestId('space-link-expiry-select').parentElement as HTMLElement).getByRole('combobox')
    );
    fireEvent.click(screen.getByTestId('space-link-expiry-option-90'));
    fireEvent.click(screen.getByTestId('space-link-create-btn'));

    const body = h.create.mock.calls[0][0] as { expiresAt: string; permissions?: unknown };
    expect(body.permissions).toBeUndefined();
    const delta = new Date(body.expiresAt).getTime() - before;
    expect(delta).toBeLessThanOrEqual(MAX_SPACE_LINK_DAYS * DAY_MS);
    expect(delta).toBeGreaterThan(89 * DAY_MS);
  });

  it('passes the cap and parsed domains through', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <SpaceLinksTab spaceId="s1" />
      </CssVarsProvider>
    );
    fireEvent.change(screen.getByTestId('space-link-cap-input'), { target: { value: '5' } });
    fireEvent.change(screen.getByTestId('space-link-domains-input'), { target: { value: '@Example.com, b.org' } });
    fireEvent.click(screen.getByTestId('space-link-create-btn'));
    expect(h.create.mock.calls[0][0]).toMatchObject({ available: 5, allowedDomains: ['example.com', 'b.org'] });
  });
});
