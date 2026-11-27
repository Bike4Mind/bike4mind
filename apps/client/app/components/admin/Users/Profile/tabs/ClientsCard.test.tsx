import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClientsCard } from './ClientsCard';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';

const seen = { firstSeenAt: new Date('2026-10-01T09:00:00Z'), lastSeenAt: new Date('2026-11-05T09:00:00Z') };

describe('ClientsCard', () => {
  it('shows version, last use and first use for each client seen, and a dash for the rest', () => {
    render(
      <ClientsCard user={buildProfile({ clientUsage: { web: seen, desktop: { ...seen, version: '1.4.2' } } })} />,
      {
        wrapper: ProfileTestWrapper,
      }
    );

    const desktop = screen.getByTestId('user-profile-client-desktop');
    expect(desktop).toHaveTextContent('1.4.2');
    expect(within(desktop).getByRole('time')).toHaveAttribute('datetime', '2026-11-05T09:00:00.000Z');
    expect(desktop).toHaveTextContent('First 1 Oct 2026');
    expect(screen.getByTestId('user-profile-client-web')).toHaveTextContent('First 1 Oct 2026');
    expect(screen.getByTestId('user-profile-client-cli')).toHaveTextContent('-');
    expect(screen.getByTestId('user-profile-client-api')).toHaveTextContent('-');
  });
});
