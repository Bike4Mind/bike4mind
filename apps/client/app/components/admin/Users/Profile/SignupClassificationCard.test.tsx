import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SignupVerdict } from '@bike4mind/server-utils/app/utils/signupSignals';
import { ProfileTestWrapper } from './profileTestUtils';
import { SignupClassificationCard } from './SignupClassificationCard';

const mocks = vi.hoisted(() => ({
  chart: vi.fn(),
  navigate: vi.fn(),
  verdicts: vi.fn(),
  refreshChart: vi.fn(),
  refreshVerdicts: vi.fn(),
  verdict: { suspected: true, signals: ['earlyApiKey', 'signupSpike'] } as SignupVerdict | null,
  failed: false,
  pending: false,
  truncated: false,
  verdictsTruncated: false,
  coldChart: false,
  search: {} as Record<string, unknown>,
}));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => mocks.search, useNavigate: () => mocks.navigate }));
vi.mock('../../Signups/useSignupTimeseries', () => ({
  useSignupTimeseries: (range: string) => {
    mocks.chart(range);
    return {
      data: mocks.coldChart ? undefined : { until: '2026-11-01T12:00:00.000Z', truncated: mocks.truncated },
      isError: mocks.failed,
      isPending: mocks.pending,
      refetch: mocks.refreshChart,
    };
  },
  useSignupVerdicts: (...args: unknown[]) => {
    mocks.verdicts(...args);
    return {
      data: { verdicts: { example: mocks.verdict }, truncated: mocks.verdictsTruncated },
      isError: false,
      isPending: false,
      refetch: mocks.refreshVerdicts,
    };
  },
}));
const renderCard = () => render(<SignupClassificationCard userId="example" />, { wrapper: ProfileTestWrapper });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.failed = false;
  mocks.pending = false;
  mocks.truncated = false;
  mocks.verdictsTruncated = false;
  mocks.coldChart = false;
  mocks.search = {};
  mocks.verdict = { suspected: true, signals: ['earlyApiKey', 'signupSpike'] };
});

describe('profile signup classification', () => {
  it('explains each matching signal and uses the same chart snapshot as the Users table', () => {
    renderCard();
    expect(screen.getByText('Suspected')).toBeInTheDocument();
    expect(screen.getByTestId('signup-classification-reason-earlyApiKey')).toHaveTextContent(
      'An API key was created within 24 hours'
    );
    expect(screen.getByTestId('signup-classification-reason-signupSpike')).toHaveTextContent(
      'ten times the usual number'
    );
    expect(screen.getByTestId('signup-classification-rule')).toHaveTextContent('one strong signal or two weaker');
    expect(mocks.verdicts).toHaveBeenCalledWith('7d', '2026-11-01T12:00:00.000Z', ['example'], undefined);
    expect(screen.getByText(/separate from the AI advisory and account access/)).toBeInTheDocument();
  });

  it('identifies a strong signal, while a single weak signal remains likely legit', () => {
    mocks.verdict = { suspected: true, signals: ['domainBurst'] };
    const { rerender } = renderCard();
    expect(screen.getByTestId('signup-classification-reason-domainBurst')).toHaveTextContent('strong signal');
    mocks.verdict = { suspected: false, signals: ['earlyApiKey'] };
    rerender(<SignupClassificationCard userId="example" />);
    expect(screen.getByText('Likely legit')).toBeInTheDocument();
    expect(screen.getByTestId('signup-classification-rule')).toHaveTextContent('do not meet');
  });

  it('does not show missing coverage as a legitimate-user verdict', () => {
    mocks.verdict = null;
    mocks.truncated = true;
    renderCard();
    expect(screen.getByTestId('signup-classification-unavailable')).toHaveTextContent('not a legitimate-user verdict');
    expect(screen.queryByText('Likely legit')).not.toBeInTheDocument();
    expect(screen.getByText(/Classification coverage is incomplete/)).toBeInTheDocument();
  });

  it('shows failed and pending reads explicitly instead of reporting safety', () => {
    mocks.failed = true;
    const { rerender } = renderCard();
    expect(screen.getByText('Signup classification could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('Suspected')).not.toBeInTheDocument();
    mocks.failed = false;
    mocks.pending = true;
    rerender(<SignupClassificationCard userId="example" />);
    expect(screen.getByText('Loading signup classification...')).toBeInTheDocument();
  });

  it('requeries classification when the operator selects another window', () => {
    renderCard();
    fireEvent.click(screen.getByRole('combobox', { name: 'Signup classification range' }));
    fireEvent.click(screen.getByRole('option', { name: 'Last 30 days' }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/admin/users/$userId',
      params: { userId: 'example' },
      search: { signupRange: '30d' },
      replace: true,
    });
  });

  it('uses the range and evaluation snapshot carried from the Users table', () => {
    const asOf = new Date(Date.now() - 1_000).toISOString();
    mocks.search = { signupRange: '30d', signupAsOf: asOf, signupTzOffset: 480 };
    renderCard();
    expect(mocks.chart).toHaveBeenLastCalledWith('30d');
    expect(mocks.verdicts).toHaveBeenLastCalledWith('30d', asOf, ['example'], 480);
  });

  it('refreshes an expired snapshot while retaining its selected range', () => {
    mocks.search = { signupRange: '90d', signupAsOf: '2020-01-01T00:00:00.000Z' };
    renderCard();
    expect(mocks.verdicts).toHaveBeenLastCalledWith('90d', '2026-11-01T12:00:00.000Z', ['example'], undefined);
  });

  it('reacts to classification context changes from browser navigation', () => {
    const { rerender } = renderCard();
    mocks.search = { signupRange: '90d' };
    rerender(<SignupClassificationCard userId="example" />);
    expect(mocks.verdicts).toHaveBeenLastCalledWith('90d', '2026-11-01T12:00:00.000Z', ['example'], undefined);
  });

  it('forces a fresh chart read when refreshing a carried snapshot', async () => {
    mocks.search = { signupRange: '30d', signupAsOf: new Date(Date.now() - 1_000).toISOString() };
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh classification' }));
    await waitFor(() => expect(mocks.refreshChart).toHaveBeenCalledOnce());
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/admin/users/$userId',
      params: { userId: 'example' },
      search: { signupRange: '30d' },
      replace: true,
    });
  });
  it('shows scan-cap coverage from verdicts for a carried snapshot with a cold chart cache', () => {
    const asOf = new Date(Date.now() - 1_000).toISOString();
    mocks.search = { signupRange: '30d', signupAsOf: asOf };
    mocks.coldChart = true;
    mocks.verdictsTruncated = true;
    renderCard();
    expect(mocks.verdicts).toHaveBeenLastCalledWith('30d', asOf, ['example'], undefined);
    expect(screen.getByText(/Classification coverage is incomplete/)).toBeInTheDocument();
  });
});
