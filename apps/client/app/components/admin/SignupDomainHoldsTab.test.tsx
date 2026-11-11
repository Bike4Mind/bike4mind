import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUser } from '@client/app/contexts/UserContext';
import type { SignupDomainReview } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { adminActionCountsQueryKey } from '@client/app/hooks/data/adminActionCounts';
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
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={theme}>
        <SignupDomainHoldsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return invalidate;
}

const openMenu = async (domain: string) =>
  fireEvent.click(await screen.findByTestId(`signup-domain-actions-${domain}`));
const confirmDialog = async () => {
  fireEvent.click(await screen.findByTestId('signup-domain-decision-dialog-reason-input-preset-0'));
  fireEvent.click(screen.getByTestId('signup-domain-decision-dialog-confirm-btn'));
};
const decideThroughDialog = async (domain: string, action: 'release' | 'confirm') => {
  await openMenu(domain);
  fireEvent.click(screen.getByTestId(`signup-domain-${action}-${domain}`));
  await confirmDialog();
};
const expectDisabledItem = (testId: string) =>
  expect(screen.getByTestId(testId)).toHaveAttribute('aria-disabled', 'true');
const expectEnabledItem = (testId: string) =>
  expect(screen.getByTestId(testId)).not.toHaveAttribute('aria-disabled', 'true');

const listParams = (overrides: Record<string, unknown> = {}) => ({
  params: { page: 1, status: 'pending', includeOlder: 'false', ...overrides },
});

beforeEach(() => {
  useUser.setState({ currentUser: { id: 'admin-1', isAdmin: true } as never });
  router.set({});
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockResolvedValue({ data: { data: reviews, total: 50 } });
});

describe('SignupDomainHoldsTab', () => {
  it('reports a failed list request for both tables instead of claiming the source refresh has not run', async () => {
    getMock.mockRejectedValue(new Error('Holds unavailable'));
    renderTab();

    const errors = await screen.findAllByTestId('admin-error-state');
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error).toHaveTextContent('Holds unavailable');
    expect(screen.queryByText('The disposable list refresh has not run yet')).not.toBeInTheDocument();
  });

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
    await openMenu('beta.test');
    expectEnabledItem('signup-domain-release-beta.test');
    expectDisabledItem('signup-domain-confirm-beta.test');
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
    expect(screen.getByTestId('signup-domain-assessment-gamma.test')).toHaveTextContent(
      'Advisory assessment failed (provider error, attempt 2)'
    );
  });
  it('marks a hold the advisory assessment released as auto-released', async () => {
    getMock.mockResolvedValue({
      data: {
        data: [
          {
            ...reviews[0],
            status: 'released',
            reason: 'young-domain (<30 days)',
            autoDecision: { policy: 'advisory-decision', decidedAt: '2026-01-02T00:00:00.000Z' },
          },
        ],
        total: 1,
      },
    });
    renderTab();
    expect(await screen.findByTestId(`signup-domain-auto-decision-${reviews[0].domain}`)).toHaveTextContent(
      'Auto-released by the advisory assessment'
    );
  });
  it('lets an admin confirm or take over an auto-released hold through the explicit Release dialog', async () => {
    getMock.mockResolvedValue({
      data: {
        data: [
          {
            ...reviews[0],
            status: 'released',
            autoDecision: { policy: 'advisory-decision', decidedAt: '2026-01-02T00:00:00.000Z' },
          },
        ],
        total: 1,
      },
    });
    postMock.mockResolvedValue({ data: { status: 'released', creditsReleased: 0, remaining: 0, nextCursor: null } });
    renderTab();
    await openMenu('alpha.test');
    expectEnabledItem('signup-domain-confirm-alpha.test');
    expect(screen.getByTestId('signup-domain-release-alpha.test')).toHaveTextContent('Release hold');
    fireEvent.click(screen.getByTestId('signup-domain-release-alpha.test'));
    await confirmDialog();
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(endpoint, {
        domain: 'alpha.test',
        action: 'release',
        overrideAutoDecision: true,
      })
    );
  });
  it('retries an auto-released hold payout in one click without taking it over', async () => {
    getMock.mockResolvedValue({
      data: {
        data: [
          {
            ...reviews[0],
            status: 'released',
            autoDecision: { policy: 'advisory-decision', decidedAt: '2026-01-02T00:00:00.000Z' },
          },
        ],
        total: 1,
      },
    });
    postMock.mockResolvedValue({ data: { status: 'released', creditsReleased: 25, remaining: 0, nextCursor: null } });
    renderTab();
    await openMenu('alpha.test');
    fireEvent.click(screen.getByTestId('signup-domain-retry-alpha.test'));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(endpoint, { domain: 'alpha.test', action: 'release' }));
    expect(screen.queryByTestId('signup-domain-decision-dialog')).not.toBeInTheDocument();
  });
  it('offers no auto-release retry on a pending hold', async () => {
    renderTab();
    await openMenu('alpha.test');
    expect(screen.getByTestId('signup-domain-release-alpha.test')).toBeInTheDocument();
    expect(screen.queryByTestId('signup-domain-retry-alpha.test')).not.toBeInTheDocument();
  });
  it('uses server pagination without a second local pager', async () => {
    renderTab();
    await openMenu('alpha.test');
    expectEnabledItem('signup-domain-confirm-alpha.test');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await openMenu('beta.test');
    expectDisabledItem('signup-domain-confirm-beta.test');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await openMenu('gamma.test');
    expectDisabledItem('signup-domain-confirm-gamma.test');
    expect(screen.getByTestId('signup-domain-release-gamma.test')).toHaveTextContent('Retry pending grants');
    expect(screen.queryByTestId('admin-table-page-size')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-table-next-btn')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('signup-domain-holds-next'));
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, listParams({ page: 2 })));
    await waitFor(() => expect(screen.getByTestId('signup-domain-holds-next')).toBeDisabled());
    fireEvent.click(screen.getByTestId('signup-domain-holds-previous'));
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, listParams()));
  });

  it('requests page 1 when a decision drains page 2', async () => {
    getMock
      .mockResolvedValueOnce({ data: { data: [reviews[0]], total: 26 } })
      .mockResolvedValueOnce({ data: { data: [reviews[0]], total: 26 } })
      .mockResolvedValueOnce({ data: { data: [], total: 25 } })
      .mockResolvedValue({ data: { data: [reviews[1]], total: 25 } });
    postMock.mockResolvedValue({ data: { status: 'blocked', creditsReleased: 0, remaining: 0, nextCursor: null } });
    renderTab();
    await waitFor(() => expect(screen.getByTestId('signup-domain-holds-next')).toBeEnabled());
    fireEvent.click(screen.getByTestId('signup-domain-holds-next'));
    await waitFor(() => expect(getMock).toHaveBeenNthCalledWith(2, endpoint, listParams({ page: 2 })));
    await decideThroughDialog('alpha.test', 'confirm');
    await waitFor(() => expect(getMock).toHaveBeenNthCalledWith(3, endpoint, listParams({ page: 2 })));
    await waitFor(() => expect(getMock).toHaveBeenNthCalledWith(4, endpoint, listParams()));
    await waitFor(() => expect(screen.getByTestId('signup-domain-holds-previous')).toBeDisabled());
  });

  it('sends one decision for a double-click on Retry pending grants', async () => {
    postMock.mockResolvedValue({ data: { status: 'released', creditsReleased: 0, remaining: 0, nextCursor: null } });
    renderTab();
    await openMenu('gamma.test');
    const retry = screen.getByTestId('signup-domain-release-gamma.test');
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText(/Released 0 credits/)).toBeInTheDocument());
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('does not release until the dialog is confirmed', async () => {
    postMock.mockResolvedValue({ data: { status: 'released', creditsReleased: 5, remaining: 0, nextCursor: null } });
    renderTab();
    await openMenu('alpha.test');
    fireEvent.click(screen.getByTestId('signup-domain-release-alpha.test'));
    expect(await screen.findByTestId('signup-domain-decision-dialog')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
    await confirmDialog();
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith(endpoint, {
      domain: 'alpha.test',
      action: 'release',
      afterUserId: undefined,
      overrideAutoDecision: true,
    });
  });

  it('confirms a hold only through the dialog', async () => {
    postMock.mockResolvedValue({ data: { status: 'blocked', creditsReleased: 0, remaining: 0, nextCursor: null } });
    renderTab();
    await decideThroughDialog('alpha.test', 'confirm');
    await waitFor(() => expect(screen.getByText('Domain confirmed; pending credits remain held.')).toBeInTheDocument());
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith(endpoint, { domain: 'alpha.test', action: 'confirm' });
  });

  it('offers a way out of an empty Pending view', async () => {
    getMock.mockResolvedValue({ data: { data: [], total: 0 } });
    renderTab();
    expect(await screen.findByTestId('signup-domain-holds-empty')).toHaveTextContent(
      'No holds are waiting for a decision.'
    );
    fireEvent.click(screen.getByTestId('signup-domain-holds-empty-action'));
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, listParams({ status: 'all' })));
  });

  it('clears the reason filter from the empty state action', async () => {
    router.set({ holdStatus: 'all', holdReason: 'young-domain' });
    getMock.mockResolvedValue({ data: { data: [], total: 0 } });
    renderTab();
    fireEvent.click(await screen.findByTestId('signup-domain-holds-empty-action'));
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, listParams({ status: 'all' })));
    expect(router.get().holdReason).toBeFalsy();
  });

  it('explains why Confirm hold is unavailable on a settled hold', async () => {
    renderTab();
    await openMenu('gamma.test');
    expect(screen.getByTestId('signup-domain-confirm-hint-gamma.test')).toHaveTextContent(
      'Only pending or auto-released holds'
    );
  });

  it('refreshes pending exposure when a domain release fails after possible payouts', async () => {
    postMock.mockRejectedValue(new Error('Request interrupted'));
    const invalidate = renderTab();
    await decideThroughDialog('alpha.test', 'release');
    expect(await screen.findByText('Request interrupted')).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'signup-grants'] });
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
    const invalidate = renderTab();
    await decideThroughDialog('alpha.test', 'release');
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'signup-grants'] });
    await decideThroughDialog('beta.test', 'release');
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));
    await openMenu('gamma.test');
    fireEvent.click(await screen.findByTestId('signup-domain-release-gamma.test'));
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(3));
    await openMenu('alpha.test');
    fireEvent.click(await screen.findByTestId('signup-domain-release-alpha.test'));
    await confirmDialog();
    await waitFor(() =>
      expect(postMock).toHaveBeenLastCalledWith(endpoint, {
        domain: 'alpha.test',
        action: 'release',
        afterUserId: 'alpha-cursor',
        overrideAutoDecision: true,
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
    expect(await screen.findByTestId('signup-domain-aged-alpha.test')).toHaveTextContent(
      'Domain now agedPast the young-domain threshold (registered'
    );
    expect(screen.getByTestId('signup-domain-aged-alpha.test')).not.toHaveTextContent('Release');
    expect(screen.queryByTestId('signup-domain-aged-beta.test')).not.toBeInTheDocument();
    expect(screen.queryByTestId('signup-domain-aged-delta.test')).not.toBeInTheDocument();
  });

  it('says that decisions only touch free signup credits and that Release is permanent', async () => {
    renderTab();
    fireEvent.mouseEnter(await screen.findByTestId('signup-domain-holds-help-btn'));
    const help = await screen.findByRole('tooltip');
    expect(help).toHaveTextContent('Confirm and Release only change free signup credits, never the account itself.');
    expect(help).toHaveTextContent('exempts the domain from holds permanently; it cannot be re-blocked');
  });

  it('hides the aged caption when the latest assessment judged abuse', async () => {
    getMock.mockResolvedValue({
      data: {
        data: [
          {
            ...reviews[0],
            reason: 'young-domain (<30 days)',
            domainAgedAt: new Date('2026-01-05'),
            assessment: {
              outcome: 'judged',
              policyVersion: 1,
              judgment: 'abuse',
              confidence: 0.7,
              model: 'gpt-6-luna',
              assessedAt: '2026-01-02T00:00:00.000Z',
            },
          },
        ],
        total: 1,
      },
    });
    renderTab();
    await screen.findByTestId('signup-domain-assessment-alpha.test');
    expect(screen.queryByTestId('signup-domain-aged-alpha.test')).not.toBeInTheDocument();
  });

  it('shows how long each hold has waited and flags pending holds older than 24 hours', async () => {
    getMock.mockResolvedValue({
      data: {
        data: [
          reviews[0],
          reviews[1],
          {
            ...reviews[2],
            domain: 'fresh.test',
            status: 'held_pending_review',
            triggeredAt: new Date(Date.now() - 3_600_000),
          },
        ],
        total: 3,
      },
    });
    renderTab();
    expect(await screen.findByTestId('signup-domain-stale-alpha.test')).toHaveTextContent('Waiting over 24h');
    expect(screen.getByTestId('signup-domain-held-at-alpha.test')).toHaveTextContent(/^Held .+ ago$/);
    expect(screen.queryByTestId('signup-domain-stale-beta.test')).not.toBeInTheDocument();
    expect(screen.getByTestId('signup-domain-held-at-fresh.test')).toHaveTextContent('Held 1 hour ago');
    expect(screen.queryByTestId('signup-domain-stale-fresh.test')).not.toBeInTheDocument();
  });

  it('links each domain to its site in a new tab', async () => {
    renderTab();
    const link = await screen.findByTestId('signup-domain-open-alpha.test');
    expect(link).toHaveAttribute('href', 'https://alpha.test');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  });

  it('sends nothing when the release dialog is cancelled', async () => {
    renderTab();
    await openMenu('alpha.test');
    fireEvent.click(screen.getByTestId('signup-domain-release-alpha.test'));
    expect(await screen.findByTestId('signup-domain-decision-dialog')).toHaveTextContent(
      'exempt the domain from holds'
    );
    fireEvent.click(screen.getByTestId('signup-domain-decision-dialog-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('signup-domain-decision-dialog')).not.toBeInTheDocument());
    expect(postMock).not.toHaveBeenCalled();
  });

  it('confirms a hold only after the dialog', async () => {
    postMock.mockResolvedValue({ data: { status: 'blocked', creditsReleased: 0, remaining: 0, nextCursor: null } });
    renderTab();
    await decideThroughDialog('alpha.test', 'confirm');
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(endpoint, { domain: 'alpha.test', action: 'confirm' }));
  });

  it('refreshes the sidebar action counts after a decision', async () => {
    postMock.mockResolvedValue({ data: { status: 'blocked', creditsReleased: 0, remaining: 0, nextCursor: null } });
    const invalidate = renderTab();
    await decideThroughDialog('alpha.test', 'confirm');
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: adminActionCountsQueryKey }));
  });

  it('drops the retry guidance once a release has nothing left', async () => {
    postMock.mockResolvedValue({ data: { status: 'released', creditsReleased: 1000, remaining: 0, nextCursor: null } });
    renderTab();
    await decideThroughDialog('alpha.test', 'release');
    expect(await screen.findByTestId('signup-domain-holds-release-result')).toHaveTextContent(
      /^Released 1,000 credits\.$/
    );
  });

  it('keeps the retry guidance while grants remain', async () => {
    postMock.mockResolvedValue({
      data: { status: 'released', creditsReleased: 5, remaining: 2, nextCursor: 'cursor' },
    });
    renderTab();
    await decideThroughDialog('alpha.test', 'release');
    expect(await screen.findByTestId('signup-domain-holds-release-result')).toHaveTextContent(
      'Released 5 credits. 2 pending grants remain'
    );
  });

  it('disables Confirm and Release for a delegate without the moderation and credit permissions', async () => {
    useUser.setState({ currentUser: { id: 'd-1', isAdmin: false, adminPermissions: ['support:read'] } as never });
    renderTab();
    await openMenu('alpha.test');
    expectDisabledItem('signup-domain-confirm-alpha.test');
    expectDisabledItem('signup-domain-release-alpha.test');
  });
});
