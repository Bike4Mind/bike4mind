import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignupDomainReview } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import SignupDomainHoldsTab from './SignupDomainHoldsTab';

const { getMock, postMock, router } = vi.hoisted(() => {
  let search: Record<string, unknown> = {};
  const listeners = new Set<() => void>();
  return {
    getMock: vi.fn(),
    postMock: vi.fn(),
    router: {
      get: () => search,
      set: (next: Record<string, unknown>) => {
        search = next;
        listeners.forEach(listener => listener());
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
});
// Fills the fields every list response carries, so each test only states the rows it cares about.
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    get: async (...args: unknown[]) => {
      const response = (await getMock(...args)) as { data: Record<string, unknown> };
      return {
        data: {
          counts: { pending: 0, blocked: 0, released: 0, all: 0 },
          settledVisibleDays: 90,
          sources: [],
          intelCacheSize: 0,
          ...response.data,
        },
      };
    },
    post: postMock,
  },
}));
vi.mock('@tanstack/react-router', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useSearch: () => useSyncExternalStore(router.subscribe, router.get),
    useNavigate:
      () =>
      async ({ search }: { search: (previous: Record<string, unknown>) => Record<string, unknown> }) =>
        router.set(search(router.get())),
  };
});

const theme = extendTheme({ ...getThemeConfig() });
const endpoint = '/api/admin/signup-domain-holds';
const reviewInputs = [
  ['alpha.test', 'held_pending_review'],
  ['beta.test', 'blocked'],
  ['gamma.test', 'released'],
] as const;
const reviews: SignupDomainReview[] = reviewInputs.map(([domain, status]) => ({
  domain,
  status,
  reason: 'Generated signup pattern',
  triggeredAt: new Date('2026-01-01'),
  cohortUserIds: [],
  sampleEmails: [`user@${domain}`],
  signupCount: 5,
}));

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <SignupDomainHoldsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}

const listParams = (overrides: Record<string, unknown> = {}) => ({
  params: { page: 1, status: 'pending', includeOlder: 'false', ...overrides },
});

beforeEach(() => {
  router.set({});
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockResolvedValue({ data: { data: reviews, total: 50 } });
});

describe('SignupDomainHoldsTab', () => {
  it('marks a hold the disposable list rule confirmed and keeps Release available', async () => {
    getMock.mockResolvedValue({
      data: {
        data: [
          {
            ...reviews[1],
            reason: 'disposable-aggregate',
            autoDecision: { policy: 'disposable-aggregate-rule', decidedAt: '2026-01-02T00:00:00.000Z' },
          },
          reviews[0],
        ],
        total: 2,
      },
    });
    renderTab();
    expect(await screen.findByTestId('signup-domain-auto-decision-beta.test')).toHaveTextContent(
      'Auto-confirmed by the disposable list rule'
    );
    expect(screen.queryByTestId('signup-domain-auto-decision-alpha.test')).not.toBeInTheDocument();
    expect(screen.getByTestId('signup-domain-release-beta.test')).toBeEnabled();
    expect(screen.getByTestId('signup-domain-confirm-beta.test')).toBeDisabled();
  });
  it('shows the advisory verdict, its auto-confirmation and a failed assessment', async () => {
    const young = 'young-domain (<30 days)';
    getMock.mockResolvedValue({
      data: {
        data: [
          {
            ...reviews[1],
            reason: young,
            autoDecision: { policy: 'advisory-decision', decidedAt: '2026-01-02T00:00:00.000Z' },
            assessment: {
              outcome: 'judged',
              policyVersion: 1,
              judgment: 'abuse',
              confidence: 0.94,
              model: 'gpt-6-luna',
              assessedAt: '2026-01-02T00:00:00.000Z',
            },
          },
          {
            ...reviews[0],
            reason: young,
            assessment: {
              outcome: 'judged',
              policyVersion: 1,
              judgment: 'insufficient_evidence',
              confidence: 0.6,
              model: 'gpt-6-luna',
              assessedAt: '2026-01-02T00:00:00.000Z',
            },
          },
          {
            ...reviews[2],
            status: 'held_pending_review',
            reason: young,
            assessment: {
              outcome: 'failed',
              policyVersion: 1,
              failure: 'provider_error',
              attempts: 2,
              model: 'gpt-6-luna',
              assessedAt: '2026-01-02T00:00:00.000Z',
            },
          },
        ],
        total: 3,
      },
    });
    renderTab();
    expect(await screen.findByTestId('signup-domain-assessment-beta.test')).toHaveTextContent(
      'Advisory verdict: abuse (94% confidence)'
    );
    expect(screen.getByTestId('signup-domain-auto-decision-beta.test')).toHaveTextContent(
      'Auto-confirmed by the advisory assessment'
    );
    expect(screen.getByTestId('signup-domain-assessment-alpha.test')).toHaveTextContent(
      'Advisory verdict: insufficient evidence (60% confidence)'
    );
    expect(screen.queryByTestId('signup-domain-auto-decision-alpha.test')).not.toBeInTheDocument();
    expect(screen.getByTestId('signup-domain-confirm-alpha.test')).toBeEnabled();
    expect(screen.getByTestId('signup-domain-assessment-gamma.test')).toHaveTextContent(
      'Advisory assessment failed (provider error, attempt 2)'
    );
  });
  it('uses server pagination without a second local pager', async () => {
    renderTab();
    expect(await screen.findByTestId('signup-domain-confirm-alpha.test')).toBeEnabled();
    expect(screen.getByTestId('signup-domain-confirm-beta.test')).toBeDisabled();
    expect(screen.getByTestId('signup-domain-confirm-gamma.test')).toBeDisabled();
    expect(screen.getByTestId('signup-domain-release-gamma.test')).toHaveTextContent('Retry pending grants');
    expect(screen.queryByTestId('admin-table-page-size')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-table-next-btn')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('signup-domain-holds-next'));
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, listParams({ page: 2 })));
    await waitFor(() => expect(screen.getByTestId('signup-domain-holds-next')).toBeDisabled());
    fireEvent.click(screen.getByTestId('signup-domain-holds-previous'));
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, listParams()));
  });

  it('sends one decision for a double-click', async () => {
    postMock.mockResolvedValue({ data: { status: 'blocked', creditsReleased: 0, remaining: 0, nextCursor: null } });
    renderTab();
    const confirm = await screen.findByTestId('signup-domain-confirm-alpha.test');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('Domain confirmed; pending credits remain held.')).toBeInTheDocument());
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('keeps each domain release cursor when retrying pending grants', async () => {
    postMock
      .mockResolvedValueOnce({
        data: { status: 'released', creditsReleased: 5, remaining: 1, nextCursor: 'alpha-cursor' },
      })
      .mockResolvedValueOnce({
        data: { status: 'released', creditsReleased: 5, remaining: 1, nextCursor: 'beta-cursor' },
      })
      .mockResolvedValue({ data: { status: 'released', creditsReleased: 0, remaining: 0, nextCursor: null } });
    renderTab();
    fireEvent.click(await screen.findByTestId('signup-domain-release-alpha.test'));
    await waitFor(() => expect(screen.getByTestId('signup-domain-release-beta.test')).toBeEnabled());
    fireEvent.click(screen.getByTestId('signup-domain-release-beta.test'));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('signup-domain-release-alpha.test')).toBeEnabled());
    fireEvent.click(screen.getByTestId('signup-domain-release-alpha.test'));
    await waitFor(() =>
      expect(postMock).toHaveBeenLastCalledWith(endpoint, {
        domain: 'alpha.test',
        action: 'release',
        afterUserId: 'alpha-cursor',
      })
    );
  });

  it('asks for pending holds by default and switches status from the view tabs', async () => {
    getMock.mockResolvedValue({
      data: { data: [reviews[0]], total: 1, counts: { pending: 1, blocked: 4, released: 2, all: 7 } },
    });
    renderTab();
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, listParams()));
    expect(await screen.findByTestId('signup-domain-holds-status-pending-count')).toHaveTextContent('1');
    expect(screen.getByTestId('signup-domain-holds-status-pending-btn')).toHaveAttribute('aria-pressed', 'true');
    for (const status of ['blocked', 'released', 'all'] as const) {
      fireEvent.click(screen.getByTestId(`signup-domain-holds-status-${status}-btn`));
      await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, listParams({ status })));
      expect(router.get().holdStatus).toBe(status);
    }
    fireEvent.click(screen.getByTestId('signup-domain-holds-status-pending-btn'));
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, listParams()));
    expect(router.get().holdStatus).toBeUndefined();
  });

  it('reads the reason filter and include-older toggle from the URL and goes back to page 1', async () => {
    router.set({ holdStatus: 'released', holdReason: 'young-domain' });
    renderTab();
    await waitFor(() =>
      expect(getMock).toHaveBeenLastCalledWith(endpoint, listParams({ status: 'released', reason: 'young-domain' }))
    );
    await waitFor(() => expect(screen.getByTestId('signup-domain-holds-next')).toBeEnabled());
    fireEvent.click(screen.getByTestId('signup-domain-holds-next'));
    await waitFor(() =>
      expect(getMock).toHaveBeenLastCalledWith(
        endpoint,
        listParams({ status: 'released', reason: 'young-domain', page: 2 })
      )
    );
    fireEvent.click(screen.getByTestId('signup-domain-holds-include-older-toggle'));
    await waitFor(() =>
      expect(getMock).toHaveBeenLastCalledWith(
        endpoint,
        listParams({ status: 'released', reason: 'young-domain', includeOlder: 'true' })
      )
    );
    expect(router.get().holdOlder).toBe('true');
  });

  it('marks a pending young-domain hold whose domain has aged, but not a settled one', async () => {
    const young = 'young-domain (<30 days)';
    getMock.mockResolvedValue({
      data: {
        data: [
          {
            ...reviews[0],
            reason: young,
            domainRegisteredAt: new Date('2025-12-01'),
            domainAgedAt: new Date('2026-01-05'),
          },
          { ...reviews[1], reason: young, domainAgedAt: new Date('2026-01-05') },
          { ...reviews[2], domain: 'delta.test', status: 'held_pending_review', reason: young },
        ],
        total: 3,
      },
    });
    renderTab();
    expect(await screen.findByTestId('signup-domain-aged-alpha.test')).toHaveTextContent('Domain now aged');
    expect(screen.getByTestId('signup-domain-release-alpha.test')).toBeEnabled();
    expect(screen.queryByTestId('signup-domain-aged-beta.test')).not.toBeInTheDocument();
    expect(screen.queryByTestId('signup-domain-aged-delta.test')).not.toBeInTheDocument();
  });

  it('says that decisions only touch free signup credits and that Release is permanent', async () => {
    renderTab();
    const tab = await screen.findByTestId('signup-domain-holds-tab');
    expect(tab).toHaveTextContent('Confirm and Release only change free signup credits, never the account itself.');
    expect(tab).toHaveTextContent('exempts the domain from holds permanently; it cannot be re-blocked');
  });
});
