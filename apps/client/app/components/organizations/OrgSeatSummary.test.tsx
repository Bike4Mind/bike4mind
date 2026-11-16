import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OrgSeatSummary from './OrgSeatSummary';

const seats = vi.hoisted(() => ({ current: { maxSeats: 5, currentSeats: 4, pendingSeats: 1, availableSeats: 1 } }));
vi.mock('@client/app/hooks/data/organizations', () => ({ useOrganizationSeats: () => seats.current }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderSummary = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <OrgSeatSummary organizationId="org1" />
    </CssVarsProvider>
  );

describe('OrgSeatSummary', () => {
  it('shows used, total and pending seats in one place', () => {
    renderSummary();
    expect(screen.getByTestId('organization-members-seats-count')).toHaveTextContent('4 of 5 seats used');
    expect(screen.getByTestId('organization-members-seats-breakdown')).toHaveTextContent(
      '3 members, 1 pending invitation'
    );
    expect(screen.getByTestId('organization-members-seats-available')).toHaveTextContent('1 available');
  });

  it('says when the team has no plan', () => {
    seats.current = { maxSeats: 0, currentSeats: 1, pendingSeats: 0, availableSeats: 0 };
    renderSummary();
    expect(screen.getByTestId('organization-members-no-plan-chip')).toHaveTextContent('No Active Plan');
    expect(screen.getByTestId('organization-members-seats-count')).toHaveTextContent('1 of ∞ seats used');
  });
});
