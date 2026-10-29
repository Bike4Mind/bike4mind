import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AdminUserRiskFlags } from '@bike4mind/common';
import { UserRiskBadges } from './UserRiskBadges';
import { ProfileTestWrapper } from './profileTestUtils';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), data: undefined as unknown, isLoading: false, isError: false }));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@client/app/hooks/data/useUserRiskFlags', () => ({
  useUserRiskFlags: () => ({ data: mocks.data, isLoading: mocks.isLoading, isError: mocks.isError }),
}));

const window24h = { from: '2026-10-28T00:00:00.000Z', to: '2026-10-29T00:00:00.000Z' };

const FLAGS: AdminUserRiskFlags = {
  flags: [
    {
      id: 'failed_sign_ins',
      severity: 'warn',
      rule: '5 or more blocked or failed step-up sign-ins within 24 hours.',
      evidence: [
        { label: 'Blocked sign-ins', value: '4' },
        { label: 'Step-up failures', value: '2' },
      ],
      window: window24h,
      timeline: { types: ['signin'], from: window24h.from, to: window24h.to },
    },
    {
      id: 'prior_moderation',
      severity: 'high',
      rule: 'At least 1 moderation incident in the last 30 days.',
      evidence: [{ label: 'Incidents', value: '1' }],
      window: window24h,
    },
  ],
};

const renderBadges = (onOpenCompliance = vi.fn()) =>
  render(
    <ProfileTestWrapper>
      <UserRiskBadges userId="u1" onOpenCompliance={onOpenCompliance} />
    </ProfileTestWrapper>
  );

describe('UserRiskBadges', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.data = FLAGS;
    mocks.isLoading = false;
    mocks.isError = false;
  });

  it('shows a named badge per flag and no composite score', () => {
    renderBadges();
    expect(screen.getByTestId('user-risk-badge-failed_sign_ins')).toHaveTextContent('Repeated failed sign-ins');
    expect(screen.getByTestId('user-risk-badge-prior_moderation')).toHaveTextContent('Prior moderation');
    expect(screen.getByTestId('user-risk-badges').textContent).not.toMatch(/score/i);
    expect(screen.queryByTestId('user-risk-badge-evidence')).toBeNull();
  });

  it('opens raw evidence on click and links to the timeline with its filter', () => {
    renderBadges();
    fireEvent.click(screen.getByTestId('user-risk-badge-failed_sign_ins'));
    expect(screen.getByTestId('user-risk-badge-evidence')).toHaveTextContent('5 or more blocked');
    expect(screen.getAllByTestId('user-risk-badge-evidence-row')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('user-risk-badge-timeline-link'));
    const updater = mocks.navigate.mock.calls[0][0].search as (p: object) => Record<string, unknown>;
    expect(updater({ keep: 1 })).toMatchObject({
      keep: 1,
      tab: 'activity',
      types: 'signin',
      from: '2026-10-28',
      to: '2026-10-29',
    });
  });

  it('opens the compliance modal from the moderation flag instead of the timeline', () => {
    const onOpenCompliance = vi.fn();
    renderBadges(onOpenCompliance);
    fireEvent.click(screen.getByTestId('user-risk-badge-prior_moderation'));
    expect(screen.queryByTestId('user-risk-badge-timeline-link')).toBeNull();
    fireEvent.click(screen.getByTestId('user-risk-badge-compliance-link'));
    expect(onOpenCompliance).toHaveBeenCalledTimes(1);
  });

  it('shows a neutral empty state when nothing fired', () => {
    mocks.data = { flags: [] };
    renderBadges();
    expect(screen.getByTestId('user-risk-badges-empty')).toHaveTextContent('No risk flags');
  });

  it.each([{ isLoading: true }, { isError: true }])('renders nothing while %o', state => {
    Object.assign(mocks, state, { data: undefined });
    renderBadges();
    expect(screen.queryByTestId('user-risk-badges')).toBeNull();
  });
});
