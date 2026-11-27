import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { IOrganizationDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import TeamOnboardingChecklist from './TeamOnboardingChecklist';

const state = vi.hoisted(() => ({ connected: false }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useOrganizationSeats: () => ({ pendingSeats: 0, availableSeats: 2 }),
}));
vi.mock('@client/app/hooks/data/useOrgSlackWorkspace', () => ({
  useGetOrgSlackWorkspace: () => ({ data: { enabled: state.connected } }),
}));
vi.mock('@client/app/hooks/data/useOrgGitHubConnection', () => ({ useGetOrgGitHubConnection: () => ({ data: null }) }));
vi.mock('@client/app/hooks/data/useOrgWebhooks', () => ({ useGetOrgWebhookConfig: () => ({ data: null }) }));
const theme = extendTheme({ ...getThemeConfig() });
const organization = { id: 'org1', userId: 'owner', users: [], systemPrompt: '' } as unknown as IOrganizationDocument;
const open = vi.fn();
const mount = () =>
  render(
    <CssVarsProvider theme={theme}>
      <TeamOnboardingChecklist organization={organization} userId="owner" onOpen={open} />
    </CssVarsProvider>
  );

describe('owner onboarding', () => {
  beforeEach(() => {
    localStorage.clear();
    state.connected = false;
    open.mockClear();
  });

  it('opens the relevant tab and automatically marks spare seats done', () => {
    mount();
    expect(screen.getByTestId('team-onboarding-seats-done')).toBeTruthy();
    fireEvent.click(screen.getByTestId('team-onboarding-context-open-btn'));
    expect(open).toHaveBeenCalledWith('settings');
  });

  it('persists individual dismissals across remounts', () => {
    const view = mount();
    fireEvent.click(screen.getByTestId('team-onboarding-members-dismiss-btn'));
    view.unmount();
    mount();
    expect(screen.queryByText('Invite members')).toBeNull();
    expect(screen.getByText('Set the team AI context')).toBeTruthy();
  });

  it('hides once all steps are complete or dismissed', () => {
    state.connected = true;
    mount();
    expect(screen.getByTestId('team-onboarding-integrations-done')).toBeTruthy();
    fireEvent.click(screen.getByTestId('team-onboarding-members-dismiss-btn'));
    fireEvent.click(screen.getByTestId('team-onboarding-context-dismiss-btn'));
    expect(screen.queryByTestId('team-onboarding-checklist')).toBeNull();
  });

  it('persists dismissal of the whole checklist', () => {
    const view = mount();
    fireEvent.click(screen.getByTestId('team-onboarding-dismiss-btn'));
    view.unmount();
    mount();
    expect(screen.queryByTestId('team-onboarding-checklist')).toBeNull();
  });
});
