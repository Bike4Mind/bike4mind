import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProviderBundle } from './ProviderBundle';

/**
 * Regression coverage for #3238's review: useDataLakeBatchCompletionSync must fire on every
 * route that carries the upload wizard, including standalone premium routes that render
 * ProviderBundle WITHOUT NotebookLayout (router.tsx's standalone-premium-route branch). This
 * file renders ProviderBundle bare - no NotebookLayout anywhere in the tree - to prove the
 * subscription does not depend on it. Every other ProviderBundle child is a real
 * provider/component with its own API calls and hook chains (LLMContext, AdminSettingsContext,
 * etc.), so they're stubbed out here; this file is not a test of those components.
 */

const { subscribeToAction, passthrough } = vi.hoisted(() => ({
  subscribeToAction: vi.fn(() => () => {}),
  passthrough: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction }),
}));

vi.mock('./InboxContext', () => ({ InboxProvider: passthrough }));
vi.mock('./LLMContext', () => ({ LLMProvider: () => null }));
vi.mock('./OrganizationContext', () => ({ OrganizationProvider: passthrough }));
vi.mock('./SessionsContext', () => ({ SessionsProvider: passthrough }));
vi.mock('./UserSettingsContext', () => ({ UserSettingsProvider: passthrough }));
vi.mock('./AdminSettingsContext', () => ({ AdminSettingsProvider: passthrough }));
vi.mock('@client/app/components/Project/ProjectAddToModal', () => ({ ProjectAddToModalProvider: passthrough }));
vi.mock('./SnackbarContext', () => ({ SnackbarProvider: passthrough }));
vi.mock('@client/app/components/organizations/CreateTeamModal', () => ({ default: () => null }));
vi.mock('./ModalTriggerContext', () => ({ ModalTriggerProvider: passthrough }));
vi.mock('@client/app/components/modals/ModalManager', () => ({ default: () => null }));
vi.mock('@client/app/components/modals/ModalErrorBoundary', () => ({ default: passthrough }));
vi.mock('@client/app/components/referrals/ReferralModal', () => ({
  default: () => null,
  ReferralInviteType: { referral: 'referral', userInvitation: 'userInvitation' },
}));
vi.mock('@client/app/components/HelpModal', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/PromptMetaInspector', () => ({ default: () => null }));
vi.mock('../components/Files/Browser', () => ({ default: () => null }));
vi.mock('@client/app/components/DataLakeWizard/SendToDataLakeModal', () => ({ default: () => null }));
vi.mock('../components/auth/MFAEnforcementWrapper', () => ({ default: passthrough }));
vi.mock('@client/app/components/EmailVerificationBanner', () => ({ default: () => null }));
vi.mock('../components/CommandPalette', () => ({ default: () => null }));

const mountBare = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ProviderBundle>
        <div data-testid="standalone-premium-route-content" />
      </ProviderBundle>
    </QueryClientProvider>
  );
  return { ...result, spy };
};

const invalidatedKeys = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map(([arg]) => JSON.stringify((arg as { queryKey?: unknown })?.queryKey));

describe('ProviderBundle - batch-completion cache sync (#3238), rendered without NotebookLayout', () => {
  beforeEach(() => {
    subscribeToAction.mockClear();
  });

  it('subscribes to batch-progress with no NotebookLayout anywhere in the tree', () => {
    mountBare();
    expect(subscribeToAction).toHaveBeenCalledWith('data_lake_batch_progress', expect.any(Function));
  });

  it('invalidates the lake list, health, tag-counts, articles, and files roots on batch completion', () => {
    const { spy } = mountBare();
    const [, onMessage] = subscribeToAction.mock.calls.at(-1)!;

    act(() => {
      onMessage({ action: 'data_lake_batch_progress', batchId: 'batch1', status: 'completed' });
    });

    expect(invalidatedKeys(spy)).toEqual(
      expect.arrayContaining([
        JSON.stringify(['data-lakes']),
        JSON.stringify(['dataLakeHealth']),
        JSON.stringify(['dataLakeTagCounts']),
        JSON.stringify(['dataLakeArticles']),
        JSON.stringify(['dataLakeFiles']),
      ])
    );
  });

  it('does not invalidate on an ordinary progress tick', () => {
    const { spy } = mountBare();
    const [, onMessage] = subscribeToAction.mock.calls.at(-1)!;

    act(() => {
      onMessage({ action: 'data_lake_batch_progress', batchId: 'batch1', chunkedFiles: 1 });
    });

    expect(invalidatedKeys(spy)).toEqual([]);
  });
});
