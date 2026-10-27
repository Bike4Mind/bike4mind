import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';
import { AdminLogTab } from './recordTabs';

const activity = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@client/app/hooks/data/adminUserActivity', () => ({ useUserActivity: () => activity.current }));

const renderLog = (hasNextPage: boolean) => {
  activity.current = { data: { pages: [{ entries: [{ source: 'user' }] }] }, hasNextPage };
  render(<AdminLogTab user={buildProfile()} />, { wrapper: ProfileTestWrapper });
};

describe('AdminLogTab', () => {
  it('does not claim no admin changes while older pages are unloaded', () => {
    renderLog(true);

    expect(screen.getByTestId('user-profile-admin-log')).toHaveTextContent('Load more to check older entries.');
    expect(screen.queryByText('No admin has changed this account yet.')).not.toBeInTheDocument();
  });

  it('says no admin has changed the account once every page is loaded', () => {
    renderLog(false);

    expect(screen.getByText('No admin has changed this account yet.')).toBeInTheDocument();
  });
});
