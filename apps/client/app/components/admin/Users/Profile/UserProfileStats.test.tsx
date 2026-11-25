import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { UserSignIn } from '@bike4mind/common';
import { ProfileTestWrapper, buildProfile } from './profileTestUtils';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get } }));
vi.mock('@client/app/hooks/data/adminUserCredits', () => ({
  useAdminCreditSummary: () => ({ data: undefined, isError: false }),
}));
vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useAdminGetUserApiKeys: () => ({ data: { apiKeys: [] }, isError: false }),
}));

import { UserProfileStats } from './UserProfileStats';

const failedSignIns: UserSignIn[] = Array.from({ length: 50 }, (_, index) => ({
  id: `failed-${index}`,
  at: new Date('2026-11-12T10:00:00Z'),
  event: 'step_up_failed',
  result: 'failed',
}));
const renderStats = () => render(<UserProfileStats user={buildProfile()} />, { wrapper: ProfileTestWrapper });

const signInTile = () => {
  const tile = screen.getAllByTestId('admin-stat-tile').find(tile => within(tile).queryByText('Last sign-in'));
  if (!tile) throw new Error('Missing sign-in tile');
  return within(tile);
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReset();
});

describe('profile sign-in summary', () => {
  it('does not claim Never when the latest success is beyond the loaded mixed-event page', async () => {
    mocks.get.mockImplementation(async (_url: string, options: { params: { cursor?: string } }) => ({
      data: options.params.cursor
        ? {
            entries: [{ ...failedSignIns[0], id: 'older-success', event: 'login_success', result: 'success' }],
            nextCursor: null,
          }
        : { entries: failedSignIns, nextCursor: 'OLDER' },
    }));
    renderStats();

    expect(await screen.findByText('No successful sign-in in loaded history')).toBeInTheDocument();
    expect(signInTile().getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith('/api/admin/users/test-user-1/sign-ins', {
      params: { limit: '50' },
    });
  });

  it('does not treat an exhausted retained audit as proof of no lifetime sign-in', async () => {
    mocks.get.mockResolvedValue({ data: { entries: [], nextCursor: null } });
    renderStats();
    expect(await screen.findByText('No successful sign-in in loaded history')).toBeInTheDocument();
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
  });

  it('shows the newest recorded success when it is loaded', async () => {
    mocks.get.mockResolvedValue({
      data: {
        entries: [
          ...failedSignIns.slice(0, 1),
          {
            id: 'success',
            at: '2026-11-11T09:00:00Z',
            event: 'login_success',
            result: 'success',
            location: 'Example location',
          },
        ],
        nextCursor: null,
      },
    });
    renderStats();
    expect(await screen.findByText('Example location')).toBeInTheDocument();
    expect(signInTile().queryByText('Unknown')).not.toBeInTheDocument();
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
  });

  it('identifies unavailable history', async () => {
    mocks.get.mockRejectedValue(new Error('history unavailable'));
    renderStats();
    expect(await screen.findByText('Sign-in history unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
  });
});
