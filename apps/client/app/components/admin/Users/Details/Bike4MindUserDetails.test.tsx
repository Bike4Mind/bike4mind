import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn() } }));

import { api } from '@client/app/contexts/ApiContext';
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

  it.each([
    [740_000_000, 'Primary'],
    [750_000_000, 'Warning'],
    [899_000_000, 'Warning'],
    [900_000_000, 'Danger'],
  ])('colours %i bytes of a 1000 MB limit as %s', (currentStorageSize, color) => {
    renderDetails({ user: { ...(user as object), storageLimit: 1000, currentStorageSize } as never });
    expect(screen.getByTestId('admin-user-storage-progress').className).toContain(`MuiLinearProgress-color${color}`);
  });

  it('reads danger when usage is over the limit', () => {
    renderDetails({ user: { ...(user as object), storageLimit: 1000, currentStorageSize: 2_000_000_000 } as never });
    const progress = screen.getByTestId('admin-user-storage-progress');
    expect(progress).toHaveAttribute('aria-valuenow', '200');
    expect(progress.className).toContain('MuiLinearProgress-colorDanger');
    expect(screen.getByTestId('admin-user-storage-label')).toHaveTextContent('2 GB / 1 GB');
  });

  // Same fixture as the SlimUsersView zero-limit case, so the list and detail screens are pinned to agree.
  it.each([0, 500_000_000])('reads a zero limit as full with %i bytes used, since every upload is refused', used => {
    renderDetails({ user: { ...(user as object), storageLimit: 0, currentStorageSize: used } as never });
    const progress = screen.getByTestId('admin-user-storage-progress');
    expect(progress).toHaveAttribute('aria-valuenow', '100');
    expect(progress.className).toContain('MuiLinearProgress-colorDanger');
  });
});

describe('Bike4MindUserDetails - signup grant support', () => {
  it('leaves existing accounts outside staged grants', () => {
    renderDetails({});
    expect(screen.getByTestId('admin-user-signup-grant')).toHaveTextContent('not enrolled');
    expect(screen.queryByTestId('admin-user-grant-unlock-btn')).toBeNull();
  });
  it('shows the released stage and requires a reason before unlock', () => {
    renderDetails({
      user: {
        ...(user as object),
        signupGrant: {
          stage: 'signup',
          signupCredits: 12,
          unlockCredits: 28,
          creditsReleased: 12,
          nextCondition: 'verification',
        },
      },
    });
    expect(screen.getByTestId('admin-user-signup-grant')).toHaveTextContent('released 12; next: verification');
    expect(screen.getByTestId('admin-user-grant-unlock-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('admin-user-grant-reason-input').querySelector('textarea')!, {
      target: { value: 'Support approved' },
    });
    expect(screen.getByTestId('admin-user-grant-unlock-btn')).not.toBeDisabled();
  });

  describe('unlock click', () => {
    const enrolled = {
      ...(user as object),
      signupGrant: {
        stage: 'signup',
        signupCredits: 12,
        unlockCredits: 28,
        creditsReleased: 12,
        nextCondition: 'verification',
      },
    };
    const submitReason = () => {
      renderDetails({ user: enrolled });
      fireEvent.change(screen.getByTestId('admin-user-grant-reason-input').querySelector('textarea')!, {
        target: { value: ' Support approved ' },
      });
      fireEvent.click(screen.getByTestId('admin-user-grant-unlock-btn'));
    };
    beforeEach(() => vi.mocked(api.post).mockReset());

    it('posts the trimmed reason and clears it on success', async () => {
      vi.mocked(api.post).mockResolvedValue({ data: {} });
      submitReason();
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/api/admin/users/u1/unlock-signup-grant', { reason: 'Support approved' })
      );
      await waitFor(() =>
        expect(screen.getByTestId('admin-user-grant-reason-input').querySelector('textarea')!).toHaveValue('')
      );
      expect(screen.queryByTestId('admin-user-grant-unlock-error')).toBeNull();
    });

    it('shows the retry message when the release fails', async () => {
      // Only the unlock call fails; the storage recalculation fired on mount must still resolve.
      vi.mocked(api.post).mockImplementation(async url => {
        if (String(url).endsWith('/unlock-signup-grant')) throw new Error('boom');
        return { data: {} };
      });
      submitReason();
      expect(await screen.findByTestId('admin-user-grant-unlock-error')).toHaveTextContent(
        'remains available for retry'
      );
    });
  });
});

describe('Bike4MindUserDetails - storage override controls', () => {
  it('marks legacy custom quotas as overrides and stages an explicit reset', () => {
    const onFieldChange = vi.fn();
    renderDetails({ onFieldChange });
    expect(screen.getByTestId('admin-user-storage-source')).toHaveTextContent('Source: override');
    fireEvent.click(screen.getByTestId('admin-user-storage-override-reset'));
    expect(onFieldChange).toHaveBeenCalledWith('storageLimitOverride', null);
  });

  it('shows the plan quota after an override is cleared', () => {
    renderDetails({ user: { ...(user as object), storageLimitOverride: null, planStorageLimit: 5000 } });
    expect(screen.getByTestId('admin-user-storage-source')).toHaveTextContent('Source: plan');
    expect(screen.getByTestId('admin-user-storage-label')).toHaveTextContent('5 GB');
    expect(screen.queryByTestId('admin-user-storage-override-reset')).not.toBeInTheDocument();
  });

  it('stages fractional MB as an override', () => {
    const onFieldChange = vi.fn();
    renderDetails({ onFieldChange });
    fireEvent.change(screen.getByTestId('admin-user-storage-override-input').querySelector('input')!, {
      target: { value: '250.5' },
    });
    expect(onFieldChange).toHaveBeenCalledWith('storageLimitOverride', 250.5);
  });
});
