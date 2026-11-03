// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useClientOutdatedStore } from '@client/app/stores/useClientOutdatedStore';
import { ClientProviders } from './providers';

/**
 * Pins that the reload banner is mounted in the app tree. Everything around it is stubbed; this is
 * not a test of those providers.
 */

const { passthrough, none } = vi.hoisted(() => ({
  passthrough: ({ children }: { children?: React.ReactNode }) => children ?? null,
  none: () => null,
}));

vi.mock('@tanstack/react-query-persist-client', () => ({ PersistQueryClientProvider: passthrough }));
vi.mock('idb-keyval', () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock('nuqs/adapters/next/pages', () => ({ NuqsAdapter: passthrough }));
vi.mock('@client/app/contexts/ApiContext', () => ({ ApiProvider: passthrough }));
vi.mock('@client/app/utils/themes', async importOriginal => {
  const actual = await importOriginal<typeof import('@client/app/utils/themes')>();
  return { ...actual, AppTheme: passthrough };
});
vi.mock('@client/app/contexts/WebsocketConfigProvider', () => ({ WebsocketConfigProvider: passthrough }));
vi.mock('@client/app/contexts/UserContext', () => ({ UserProvider: passthrough }));
vi.mock('@client/app/contexts/ServerStatusProvider', () => ({ ServerStatusProvider: passthrough }));
vi.mock('@client/app/contexts/TranslationProvider', () => ({ TranslationProvider: passthrough }));
vi.mock('@client/app/components/DefaultMetaTags', () => ({ default: none }));
vi.mock('@client/app/components/ConfirmationModal', () => ({ default: none }));
vi.mock('@client/app/components/auth/StepUpModal', () => ({ default: none }));
vi.mock('@client/app/components/WebsocketReactQueryInvalidateListener', () => ({ default: none }));
vi.mock('@client/app/components/GenerationUpdatesListener', () => ({ default: none }));
vi.mock('@client/app/components/CreditBalanceSyncListener', () => ({ default: none }));
vi.mock('@client/app/components/AgentExecutionSubscriber', () => ({ default: none }));
vi.mock('@client/app/components/stripe/StripeCheckoutSuccessHandler', () => ({ default: none }));
vi.mock('@client/app/components/stripe/StripePaymentReturnHandler', () => ({ default: none }));
vi.mock('@client/app/components/CookieConsentBanner', () => ({ CookieConsentBanner: none }));
vi.mock('@client/app/components/ImpersonationBanner', () => ({
  ImpersonationBanner: () => <div data-testid="impersonation-banner" />,
}));
vi.mock('@client/app/components/QuestPreparationOverlay', () => ({ QuestPreparationOverlay: none }));
vi.mock('@client/app/utils/localStorageCleanup', () => ({ runLocalStorageCleanup: vi.fn() }));
vi.mock('@client/app/utils/sessionBootstrap', () => ({
  revalidateSessionOnFocus: vi.fn(),
  scheduleSessionRevalidation: () => () => {},
}));
vi.mock('@client/app/utils/refreshCoordinator', () => ({ listenForSiblingRefresh: () => () => {} }));

const appTheme = extendTheme({ ...getThemeConfig() });

const mount = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ClientProviders>
        <div />
      </ClientProviders>
    </CssVarsProvider>
  );

describe('ClientProviders mounts the outdated-client banner', () => {
  beforeEach(() => useClientOutdatedStore.setState({ outdated: false }));

  it('shows nothing until a deploy is detected', () => {
    mount();
    expect(screen.queryByTestId('client-outdated-banner')).toBeNull();
    expect(screen.getByTestId('impersonation-banner')).toBeTruthy();
  });

  it('shows the banner once the client is marked outdated', () => {
    mount();
    act(() => useClientOutdatedStore.getState().markOutdated());
    expect(screen.getByTestId('client-outdated-banner')).toBeTruthy();
  });
});
