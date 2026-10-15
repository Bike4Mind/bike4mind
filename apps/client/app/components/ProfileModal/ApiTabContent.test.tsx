import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// The three key sections fetch their own data and carry their own modals; stub them so this
// test covers only what the tab composes.
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/UserApiKeysSection', () => ({
  default: () => <div data-testid="user-api-keys-section" />,
}));
vi.mock('@client/app/components/ProfileModal/SettingsTabContent/ApiKeysSection', () => ({
  default: () => <div data-testid="provider-keys-section" />,
}));
vi.mock('@client/app/components/ProfileModal/AgentConnectSection', () => ({
  default: () => <div data-testid="agent-connect-section" />,
}));

// The removed usage block rendered only when a user was signed in. Supplying one keeps that
// path armed: a signed-in user must still see no usage dashboard on this tab.
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user_1' } }),
}));

// The usage dashboard was this tab's only dynamic import. Stub next/dynamic with a marker so a
// usage chart that comes back here fails this test rather than silently reintroducing the second,
// disagreeing usage view.
vi.mock('next/dynamic', () => ({ default: () => () => <div data-testid="usage-dashboard" /> }));

import ApiTabContent from './ApiTabContent';

const appTheme = extendTheme({ ...getThemeConfig() });

// Rendered through a real router because the tab's Usage link is a TanStack <Link> that needs a
// route for `/profile` to resolve.
const renderTab = async () => {
  const rootRoute = createRootRoute({ component: () => <ApiTabContent /> });
  const profileRoute = createRoute({ getParentRoute: () => rootRoute, path: '/profile' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([profileRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <CssVarsProvider theme={appTheme}>
      <RouterProvider router={router} />
    </CssVarsProvider>
  );
  // Anchor on a section, not the link, so the "no usage dashboard" assertion below fails for its
  // own reason (a chart present) rather than because the link is missing.
  await screen.findByTestId('user-api-keys-section');
};

describe('ApiTabContent', () => {
  it('stacks the platform-key, provider-key and agent sections', async () => {
    await renderTab();

    expect(screen.getByTestId('user-api-keys-section')).toBeInTheDocument();
    expect(screen.getByTestId('provider-keys-section')).toBeInTheDocument();
    expect(screen.getByTestId('agent-connect-section')).toBeInTheDocument();
  });

  it('renders no usage dashboard', async () => {
    await renderTab();

    expect(screen.queryByTestId('usage-dashboard')).toBeNull();
  });

  it('links to the Usage tab', async () => {
    await renderTab();

    expect(screen.getByTestId('api-usage-link')).toHaveAttribute('href', '/profile?tab=usage');
  });
});
