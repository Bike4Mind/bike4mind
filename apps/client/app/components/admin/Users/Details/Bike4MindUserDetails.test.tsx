import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn() } }));

import Bike4MindUserDetails from './Bike4MindUserDetails';

const appTheme = extendTheme({ ...getThemeConfig() });
const user = {
  id: 'u1',
  currentCredits: 100,
  numReferralsAvailable: 0,
  storageLimit: 100,
  currentStorageSize: 0,
  subscribedUntil: null,
} as never;

const renderDetails = (props: Record<string, unknown>) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={appTheme}>
        <Bike4MindUserDetails
          user={user}
          userKey="u1"
          editedFields={{}}
          onFieldChange={vi.fn()}
          onCreditReasonChange={vi.fn()}
          creditReason=""
          {...props}
        />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

describe('Bike4MindUserDetails — credit reason input', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hides the reason input until credits are edited', () => {
    renderDetails({ editedFields: {} });
    expect(screen.queryByTestId('admin-credit-reason-input')).not.toBeInTheDocument();
  });

  it('shows the reason input once currentCredits is edited', () => {
    renderDetails({ editedFields: { currentCredits: true } });
    expect(screen.getByTestId('admin-credit-reason-input')).toBeInTheDocument();
  });

  it('forwards typed reason via onCreditReasonChange', () => {
    const onCreditReasonChange = vi.fn();
    renderDetails({ editedFields: { currentCredits: true }, onCreditReasonChange });

    fireEvent.change(screen.getByTestId('admin-credit-reason-input').querySelector('textarea')!, {
      target: { value: 'Manual top-up' },
    });

    expect(onCreditReasonChange).toHaveBeenCalledWith('Manual top-up');
  });
});
