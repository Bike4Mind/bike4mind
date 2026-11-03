import React from 'react';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mockNavigate = vi.fn();
let searchParams: Record<string, string | undefined>;

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useSearch: () => searchParams,
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [key: string]: unknown }) => (
    <a href={to} {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>
      {children}
    </a>
  ),
}));

let mockAccessToken: string | null = 'tok';
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: () => ({ accessToken: mockAccessToken }),
}));

vi.mock('@client/app/hooks/useGetLogo', () => ({ default: () => '/logo.png' }));

const mockPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: (...args: unknown[]) => mockPost(...args) } }));

let mockAppUrl: string | undefined;
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: () => mockAppUrl,
}));

const mockLogout = vi.fn();
vi.mock('@client/app/hooks/data/user', () => ({
  useUserLogout: () => ({ mutate: mockLogout, isPending: false }),
}));

import BedrockNewsClaimPage from './bedrocknews-claim';

const TICKET = 'tkt_abcdefghijklmnop1234';
const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);
const renderPage = () => render(<BedrockNewsClaimPage />, { wrapper: TestWrapper });

const READY = {
  state: 'ready',
  credits: 150,
  rungs: [
    { date: '2026-11-01', length: 5, hard: false },
    { date: '2026-11-02', length: 7, hard: true },
  ],
  account: 'victor@example.com',
};

const DONE = { total: 150, balance: 900, firstSolveCredits: 50, capped: 0, claimed: [] };

describe('BedrockNewsClaimPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParams = { ticket: TICKET };
    mockAccessToken = 'tok';
    mockAppUrl = 'https://news.example';
  });

  it('shows a spinner while the preview loads and posts the ticket in the body', async () => {
    mockPost.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByTestId('claim-loading')).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledWith('/api/partners/bedrocknews/claims/preview', { ticket: TICKET });
  });

  it('shows the amount, rungs and account when ready', async () => {
    mockPost.mockResolvedValue({ data: READY });
    renderPage();
    expect(await screen.findByText('Claim your Headword credits')).toBeInTheDocument();
    expect(screen.getByText('150 credits from BedrockNews Headword')).toBeInTheDocument();
    expect(screen.getByText('to victor@example.com')).toBeInTheDocument();
    expect(screen.getAllByTestId('claim-rung')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Add 150 credits' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Back to Headword' })).toHaveAttribute(
      'href',
      `https://news.example/games/headword?claim=${TICKET}`
    );
  });

  it('disables the confirm button with a spinner while redeeming, then shows the result', async () => {
    let resolveRedeem: (value: unknown) => void = () => {};
    mockPost.mockResolvedValueOnce({ data: READY }).mockReturnValueOnce(
      new Promise(resolve => {
        resolveRedeem = resolve;
      })
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add 150 credits' }));
    const busy = await screen.findByTestId('claim-confirm-btn');
    await waitFor(() => expect(busy).toBeDisabled());
    expect(busy.querySelector('[role="progressbar"]')).toBeInTheDocument();
    expect(mockPost).toHaveBeenLastCalledWith('/api/partners/bedrocknews/claims/redeem', { ticket: TICKET });

    resolveRedeem({ data: { state: 'done', result: DONE } });
    expect(await screen.findByText('150 credits added')).toBeInTheDocument();
    expect(screen.getByText('Balance 900')).toBeInTheDocument();
    expect(screen.getByText('+50 first-solve bonus')).toBeInTheDocument();
    expect(screen.queryByText(/daily limit/)).not.toBeInTheDocument();
  });

  it('shows the done result straight from a redeemed preview', async () => {
    mockPost.mockResolvedValue({
      data: { state: 'redeemed', result: { ...DONE, firstSolveCredits: 0, balance: null } },
    });
    renderPage();
    expect(await screen.findByText('150 credits added')).toBeInTheDocument();
    expect(screen.queryByText(/Balance/)).not.toBeInTheDocument();
    expect(screen.queryByText(/first-solve/)).not.toBeInTheDocument();
  });

  it('shows the capped line next to credits that were added', async () => {
    mockPost.mockResolvedValue({ data: { state: 'redeemed', result: { ...DONE, total: 100, capped: 50 } } });
    renderPage();
    expect(await screen.findByText('100 credits added')).toBeInTheDocument();
    expect(
      screen.getByText('Bike4Mind\u2019s daily limit is reached for that day, so those credits can\u2019t be paid.')
    ).toBeInTheDocument();
  });

  it('says already claimed when nothing was paid and nothing capped', async () => {
    mockPost.mockResolvedValue({ data: { state: 'redeemed', result: { ...DONE, total: 0 } } });
    renderPage();
    expect(await screen.findByText('These credits were already claimed')).toBeInTheDocument();
    expect(screen.queryByText(/credits added/)).not.toBeInTheDocument();
  });

  it('shows only the capped line when everything was capped', async () => {
    mockPost.mockResolvedValue({ data: { state: 'redeemed', result: { ...DONE, total: 0, capped: 50 } } });
    renderPage();
    expect(await screen.findByText(/daily limit is reached/)).toBeInTheDocument();
    expect(screen.queryByText('These credits were already claimed')).not.toBeInTheDocument();
    expect(screen.queryByText(/credits added/)).not.toBeInTheDocument();
  });

  it('signs out and returns to this page through the login screen', async () => {
    mockPost.mockResolvedValue({ data: READY });
    window.history.replaceState(null, '', `/partners/bedrocknews/claim?ticket=${TICKET}`);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Use another account' }));
    expect(mockLogout).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(window.location.search);
    expect(params.get('redirectTo')).toBe(`/partners/bedrocknews/claim?ticket=${TICKET}`);
  });

  it('leaves the login redirect to the sign-out when the token clears mid-logout', async () => {
    mockPost.mockResolvedValue({ data: READY });
    window.history.replaceState(null, '', `/partners/bedrocknews/claim?ticket=${TICKET}`);
    const { rerender } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Use another account' }));
    mockAccessToken = null;
    rerender(<BedrockNewsClaimPage />);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('restores the claim URL and shows unavailable when sign-out fails', async () => {
    mockPost.mockResolvedValue({ data: READY });
    mockLogout.mockImplementation((_vars: unknown, options?: { onError?: () => void }) => options?.onError?.());
    window.history.replaceState(null, '', `/partners/bedrocknews/claim?ticket=${TICKET}`);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Use another account' }));
    expect(await screen.findByText(/Couldn\u2019t reach BedrockNews/)).toBeInTheDocument();
    expect(window.location.pathname + window.location.search).toBe(`/partners/bedrocknews/claim?ticket=${TICKET}`);
  });

  it('sends a signed-out visitor to login with this page as redirectTo', async () => {
    mockAccessToken = null;
    window.history.replaceState(null, '', `/partners/bedrocknews/claim?ticket=${TICKET}`);
    renderPage();
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/login',
        search: { redirectTo: `/partners/bedrocknews/claim?ticket=${TICKET}` },
      })
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  const ERROR_CASES: [string, string][] = [
    ['expired', 'This claim link expired. Go back to Headword and press Claim again.'],
    ['not-found', 'This claim link isn\u2019t valid.'],
    ['in-progress', 'This claim is already being processed. Try again in a minute.'],
    ['budget-spent', 'Bike4Mind has paid out all of today\u2019s Headword credits. Yours are safe; try again later.'],
    ['unavailable', 'Couldn\u2019t reach BedrockNews. Your credits are safe; try again.'],
    ['verify-email', 'Verify your email to claim credits.'],
  ];

  it.each(ERROR_CASES)('renders the %s state with a back link', async (state, copy) => {
    mockPost.mockResolvedValue({ data: { state } });
    renderPage();
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Headword' })).toHaveAttribute(
      'href',
      `https://news.example/games/headword?claim=${TICKET}`
    );
  });

  it('links to the email verification flow from the verify-email state', async () => {
    mockPost.mockResolvedValue({ data: { state: 'verify-email' } });
    renderPage();
    expect(await screen.findByTestId('claim-verify-link')).toHaveAttribute('href', '/new');
  });

  it('renders a redeem-time error state and keeps the back link', async () => {
    mockPost.mockResolvedValueOnce({ data: READY }).mockResolvedValueOnce({ data: { state: 'in-progress' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add 150 credits' }));
    expect(await screen.findByText(/already being processed/)).toBeInTheDocument();
  });

  it.each(['in-progress', 'unavailable', 'budget-spent'])(
    'offers Try again after a %s redeem and re-runs the preview',
    async state => {
      mockPost
        .mockResolvedValueOnce({ data: READY })
        .mockResolvedValueOnce({ data: { state } })
        .mockResolvedValueOnce({ data: READY });
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Add 150 credits' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('button', { name: 'Add 150 credits' })).toBeInTheDocument();
      expect(mockPost).toHaveBeenLastCalledWith('/api/partners/bedrocknews/claims/preview', { ticket: TICKET });
      expect(mockPost).toHaveBeenCalledTimes(3);
    }
  );

  it.each(['unavailable', 'budget-spent', 'expired'])('does not offer Try again for a %s preview', async state => {
    mockPost.mockResolvedValue({ data: { state } });
    renderPage();
    await screen.findByTestId('claim-card');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('offers Try again for an in-progress preview and re-runs it', async () => {
    mockPost.mockResolvedValueOnce({ data: { state: 'in-progress' } }).mockResolvedValueOnce({ data: READY });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Add 150 credits' })).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost).toHaveBeenLastCalledWith('/api/partners/bedrocknews/claims/preview', { ticket: TICKET });
  });

  it('does not offer Try again after an expired redeem', async () => {
    mockPost.mockResolvedValueOnce({ data: READY }).mockResolvedValueOnce({ data: { state: 'expired' } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Add 150 credits' }));
    expect(await screen.findByText(/This claim link expired/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('redeems once when confirm is clicked twice before re-rendering', async () => {
    mockPost.mockResolvedValueOnce({ data: READY }).mockReturnValueOnce(new Promise(() => {}));
    renderPage();
    const button = await screen.findByRole('button', { name: 'Add 150 credits' });
    act(() => {
      button.click();
      button.click();
    });
    expect(mockPost.mock.calls.filter(([url]) => url === '/api/partners/bedrocknews/claims/redeem')).toHaveLength(1);
  });

  it.each([
    ['done without a result', { state: 'done' }],
    ['redeemed without a result', { state: 'redeemed' }],
    ['ready without rungs', { state: 'ready', credits: 10, account: 'a@b.c' }],
    ['an unknown state', { state: 'mystery' }],
  ])('shows the unavailable copy for %s', async (_label, data) => {
    mockPost.mockResolvedValue({ data });
    renderPage();
    expect(await screen.findByText(/Couldn\u2019t reach BedrockNews/)).toBeInTheDocument();
  });

  it.each([
    ['unset', undefined],
    ['not http(s)', 'javascript:alert(1)'],
  ])('omits the back link when the app URL is %s', async (_label, url) => {
    mockAppUrl = url;
    mockPost.mockResolvedValue({ data: { state: 'expired' } });
    renderPage();
    expect(await screen.findByText(/This claim link expired/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Back to Headword' })).not.toBeInTheDocument();
  });

  it('treats a 400 from the server as the state it carries', async () => {
    mockPost.mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { state: 'not-found' } } });
    renderPage();
    expect(await screen.findByText('This claim link isn\u2019t valid.')).toBeInTheDocument();
  });

  it('treats a network failure as unavailable', async () => {
    mockPost.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText(/Couldn\u2019t reach BedrockNews/)).toBeInTheDocument();
  });

  it('shows the invalid-link state without calling the API when there is no ticket', async () => {
    searchParams = {};
    renderPage();
    expect(await screen.findByText('This claim link isn\u2019t valid.')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('keeps the card inside a 390px viewport', async () => {
    mockPost.mockResolvedValue({ data: READY });
    renderPage();
    const card = await screen.findByTestId('claim-card');
    const style = getComputedStyle(card);
    expect(style.width).toBe('100%');
    expect(style.maxWidth).toBe('420px');
    expect(style.overflowWrap).toBe('anywhere');
  });
});
