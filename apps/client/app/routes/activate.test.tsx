import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// Regression coverage for issue #369: a not-yet-consented account authorizing the CLI must be
// routed to /accept-policies (not shown a misleading "Invalid code" error).

const mockNavigate = vi.fn();
let mockSearch: Record<string, unknown> = {};

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useSearch: () => mockSearch,
}));

let mockCurrentUser: unknown = { username: 'qaadmin', email: 'qa-admin-e2e@test.com' };
vi.mock('../contexts/UserContext', () => ({
  useUser: () => ({ currentUser: mockCurrentUser }),
}));

// Configurable mutation stub. `mutate` invokes the caller-supplied onSuccess/onError so the page's
// post-verify routing can be exercised without a real react-query mutation.
const verifyState: {
  isError: boolean;
  isSuccess: boolean;
  isPending: boolean;
  error: unknown;
  mutateImpl: (vars: unknown, opts: { onSuccess?: (d: unknown) => void; onError?: (e: unknown) => void }) => void;
} = {
  isError: false,
  isSuccess: false,
  isPending: false,
  error: null,
  mutateImpl: () => {},
};
const mockMutate = vi.fn((vars, opts) => verifyState.mutateImpl(vars, opts));
vi.mock('../hooks/data/device-auth', () => ({
  useVerifyDevice: () => ({
    mutate: mockMutate,
    isError: verifyState.isError,
    isSuccess: verifyState.isSuccess,
    isPending: verifyState.isPending,
    error: verifyState.error,
  }),
}));

import ActivatePage from './activate';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ActivatePage />
    </CssVarsProvider>
  );

describe('ActivatePage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockMutate.mockClear();
    mockSearch = { code: 'NXN6-9Q6U' };
    mockCurrentUser = { username: 'qaadmin', email: 'qa-admin-e2e@test.com' };
    verifyState.isError = false;
    verifyState.isSuccess = false;
    verifyState.isPending = false;
    verifyState.error = null;
    verifyState.mutateImpl = () => {};
  });

  it('shows a policy-acceptance message with a link to /accept-policies instead of "Invalid code"', () => {
    verifyState.isError = true;
    verifyState.error = {
      response: { data: { error: 'Policy acceptance required.', policyAcceptanceRequired: true } },
    };
    renderPage();

    expect(screen.queryByText('Invalid code')).not.toBeInTheDocument();
    expect(screen.getByText(/accept the Terms of Service/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /review and accept policies/i }));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/accept-policies',
      search: { redirectTo: '/activate?code=NXN6-9Q6U' },
    });
  });

  it('surfaces the server error_description for a non-consent failure', () => {
    verifyState.isError = true;
    verifyState.error = {
      response: { data: { error: 'invalid_code', error_description: 'Code not found or expired' } },
    };
    renderPage();

    expect(screen.getByText('Code not found or expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review and accept policies/i })).not.toBeInTheDocument();
  });

  it('routes to /accept-policies when Approve Device hits the consent gate', () => {
    verifyState.mutateImpl = (_vars, opts) => {
      opts.onError?.({ response: { data: { policyAcceptanceRequired: true } } });
    };
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /approve device/i }));
    expect(mockMutate).toHaveBeenCalledWith(
      { user_code: 'NXN6-9Q6U', action: 'approve' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) })
    );
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/accept-policies',
      search: { redirectTo: '/activate?code=NXN6-9Q6U' },
    });
  });
});
