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

describe('Bike4MindUserDetails - storage usage', () => {
  // 920,000,000 of a 1000 MB limit is 92% to enforcement, which reads storageLimit as decimal MB.
  const nearlyFullUser = { ...(user as object), storageLimit: 1000, currentStorageSize: 920_000_000 } as never;

  it('labels the limit in decimal MB, as enforcement reads it', () => {
    renderDetails({ user: nearlyFullUser });
    expect(screen.getByTestId('admin-user-storage-label')).toHaveTextContent('920 MB / 1 GB');
  });

  it('shows the danger state at 92% of the limit', () => {
    renderDetails({ user: nearlyFullUser });
    const progress = screen.getByTestId('admin-user-storage-progress');
    expect(progress).toHaveAttribute('aria-valuenow', '92');
    expect(progress.className).toContain('MuiLinearProgress-colorDanger');
  });
});
