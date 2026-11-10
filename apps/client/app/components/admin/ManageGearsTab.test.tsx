import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const m = vi.hoisted(() => ({
  currentUser: { isAdmin: false, adminPermissions: [] } as { isAdmin: boolean; adminPermissions?: string[] },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: m.currentUser }) }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    get: vi.fn(async () => ({
      data: {
        gears: [
          {
            key: 'daily',
            kind: 'skill',
            defaults: {
              credits: 10,
              enabled: true,
              title: 'Daily',
              tagline: 't',
              intro: 'i',
              cta: 'Go',
              ctaAction: 'files',
            },
            override: {
              enabled: false,
              credits: null,
              title: null,
              tagline: null,
              intro: null,
              cta: null,
              ctaAction: null,
              updatedBy: null,
              updatedAt: null,
            },
          },
        ],
      },
    })),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import ManageGearsTab from './ManageGearsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderTab = async (user: typeof m.currentUser) => {
  m.currentUser = user;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CssVarsProvider theme={appTheme}>
        <ManageGearsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  await waitFor(() => expect(screen.getByTestId('manage-gear-edit-daily')).toBeTruthy());
};

describe('ManageGearsTab write controls', () => {
  it('disables edit and reset for a support:read delegate', async () => {
    await renderTab({ isAdmin: false, adminPermissions: ['support:read'] });

    expect((screen.getByTestId('manage-gear-edit-daily') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('manage-gear-reset-daily') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByTestId('admin-missing-permission-action')).toHaveLength(2);
  });

  it('enables them for a settings:manage delegate', async () => {
    await renderTab({ isAdmin: false, adminPermissions: ['settings:manage'] });

    expect((screen.getByTestId('manage-gear-edit-daily') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('manage-gear-reset-daily') as HTMLButtonElement).disabled).toBe(false);
  });
});
