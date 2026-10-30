import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';
import { GearCard } from './GearCard';

vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const gear = {
  key: 'projects',
  kind: 'detect',
  unlocked: true,
  claimable: true,
  credits: 250,
  title: 'Projects',
  tagline: 'Organize',
  intro: 'Group your work.',
  cta: 'Open projects',
  ctaAction: 'navigate:/projects',
} as GearStatus;

describe('GearCard', () => {
  const onActivate = vi.fn();
  const onClaim = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls through to the card when there is no onClaim', async () => {
    render(<GearCard gear={gear} ctaLabel="Learn more" onActivate={onActivate} />, { wrapper: Wrapper });

    await userEvent.click(screen.getByTestId('gear-reward-projects'));

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('gear-claim-projects')).toBeNull();
  });

  it('claims from the chip without activating the card when onClaim is given', async () => {
    render(<GearCard gear={gear} ctaLabel="Learn more" onActivate={onActivate} onClaim={onClaim} />, {
      wrapper: Wrapper,
    });

    await userEvent.click(within(screen.getByTestId('gear-reward-projects')).getByRole('button'));

    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('shows the email-verification message for an unverified pending gear', () => {
    const pending = { ...gear, claimable: undefined, rewardPending: true, pendingReason: 'unverified' } as GearStatus;
    render(<GearCard gear={pending} ctaLabel="Learn more" onActivate={onActivate} onClaim={onClaim} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByTestId('gear-pending-note-projects')).toHaveTextContent('Verify your email');
  });

  it('shows the account-age message for a too-new pending gear', () => {
    const pending = { ...gear, claimable: undefined, rewardPending: true, pendingReason: 'too_new' } as GearStatus;
    render(<GearCard gear={pending} ctaLabel="Learn more" onActivate={onActivate} onClaim={onClaim} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByTestId('gear-pending-note-projects')).toHaveTextContent('7 days old');
  });

  it('shows the artifact-view message for a reward_check pending gear', () => {
    const pending = {
      ...gear,
      claimable: undefined,
      rewardPending: true,
      pendingReason: 'reward_check',
    } as GearStatus;
    render(<GearCard gear={pending} ctaLabel="Learn more" onActivate={onActivate} onClaim={onClaim} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByTestId('gear-pending-note-projects')).toHaveTextContent('artifact link');
  });
});
