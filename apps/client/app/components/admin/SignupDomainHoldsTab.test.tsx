import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignupDomainReview } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import SignupDomainHoldsTab from './SignupDomainHoldsTab';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: getMock, post: postMock } }));

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

beforeEach(() => {
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
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, { params: { page: 2 } }));
    await waitFor(() => expect(screen.getByTestId('signup-domain-holds-next')).toBeDisabled());
    fireEvent.click(screen.getByTestId('signup-domain-holds-previous'));
    await waitFor(() => expect(getMock).toHaveBeenLastCalledWith(endpoint, { params: { page: 1 } }));
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
});
