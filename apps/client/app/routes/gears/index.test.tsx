import React from 'react';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';

const { state } = vi.hoisted(() => ({
  state: {
    gears: [] as GearStatus[],
    mutate: vi.fn(),
    navigate: vi.fn(),
    isMobile: false,
  },
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn().mockResolvedValue({}) } }));
vi.mock('@client/app/hooks/useGearsStatus', () => ({
  useClaimGear: () => ({ mutate: state.mutate, isPending: false }),
}));
vi.mock('@client/app/hooks/useVisibleGears', () => ({
  useVisibleGears: () => ({ gears: state.gears, isPending: false, refetch: vi.fn() }),
}));
vi.mock('@client/app/components/Files/Browser', () => ({ useFileBrowser: () => ({ setOpen: vi.fn() }) }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => state.isMobile }));

import GearsPage from './index';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <GearsPage />
    </CssVarsProvider>
  );

const gear = (key: string, kind: GearStatus['kind'], overrides: Partial<GearStatus> = {}): GearStatus =>
  ({
    key,
    kind,
    unlocked: false,
    credits: 250,
    title: `${key} title`,
    tagline: '',
    intro: `${key} intro`,
    cta: `Try ${key}`,
    ctaAction: `navigate:/${key}`,
    ...overrides,
  }) as GearStatus;

// One gear per reward state, spread over every tab.
const FIXTURE: GearStatus[] = [
  gear('models', 'skill', { unlocked: true, claimed: true }),
  gear('projects', 'destination', { unlocked: true, claimable: true, credits: 1000 }),
  gear('agents', 'destination', { credits: 1000 }),
  gear('published', 'destination', { unlocked: true, rewardPending: true, credits: 5000 }),
  gear('mementos', 'skill', { unlocked: true, claimable: true }),
  gear('websearch', 'skill'),
  gear('image', 'skill', { unlocked: true, claimable: true, credits: 100 }),
  gear('slack', 'skill'),
];

const openTab = (name: RegExp) => userEvent.click(screen.getByRole('tab', { name }));

beforeAll(() => {
  // jsdom has no layout; the page scrolls cards and the tab strip into view.
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  state.gears = FIXTURE;
  state.mutate.mockReset();
  state.navigate.mockReset();
  state.isMobile = false;
});

describe('GearsPage reward markers', () => {
  it('draws each reward state with its own marker', () => {
    renderPage();
    // Claimed: the grey check, nothing to claim.
    expect(screen.getByTestId('gear-unlocked-models')).toBeInTheDocument();
    expect(screen.queryByTestId('gear-claim-models')).not.toBeInTheDocument();
    // Claimable: the amount chip plus the claim button.
    expect(screen.getByTestId('gear-reward-projects')).toHaveTextContent('1,000');
    expect(screen.getByTestId('gear-claim-projects')).toHaveTextContent('Claim 1,000 credits');
    // Locked: the amount, no button.
    expect(screen.getByTestId('gear-reward-agents')).toHaveTextContent('1,000');
    expect(screen.queryByTestId('gear-claim-agents')).not.toBeInTheDocument();
    // Pending: the yellow chip and the note saying what it waits for.
    expect(screen.getByTestId('gear-pending-published')).toBeInTheDocument();
    expect(screen.getByTestId('gear-pending-note-published')).toHaveTextContent(
      'Once someone else opens your artifact link, you can claim 5,000 credits.'
    );
  });

  it('draws no marker for a reward set to zero, earned or not', () => {
    state.gears = [
      gear('models', 'skill', { unlocked: true, credits: 0 }),
      gear('projects', 'destination', { credits: 0 }),
    ];
    renderPage();
    for (const key of ['models', 'projects']) {
      for (const marker of ['gear-unlocked', 'gear-reward', 'gear-pending', 'gear-claim']) {
        expect(screen.queryByTestId(`${marker}-${key}`)).not.toBeInTheDocument();
      }
    }
  });

  it('claims the gear its button belongs to, without acting as a click on the card', async () => {
    renderPage();
    await userEvent.click(screen.getByTestId('gear-claim-projects'));
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(state.mutate.mock.calls[0][0]).toBe('projects');
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it('a click on the card itself acts on its CTA and claims nothing', async () => {
    renderPage();
    await userEvent.click(screen.getByTestId('gear-card-projects'));
    expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/projects' }));
    expect(state.mutate).not.toHaveBeenCalled();
  });
});

describe('GearsPage tabs', () => {
  it('counts the claimable rewards on each tab, and shows no count where there are none', () => {
    renderPage();
    expect(screen.getByTestId('gears-tab-claimable-getting-started')).toHaveTextContent('1');
    expect(screen.getByTestId('gears-tab-claimable-features')).toHaveTextContent('1');
    expect(screen.getByTestId('gears-tab-claimable-generators')).toHaveTextContent('1');
    expect(screen.queryByTestId('gears-tab-claimable-integrations')).not.toBeInTheDocument();
  });

  it('shows every gear once across the four tabs', async () => {
    renderPage();
    const seen: string[] = [];
    for (const name of [/Getting Started/, /Explore Features/, /Generators/, /Integrations/]) {
      await openTab(name);
      const panel = screen.getByRole('tabpanel');
      seen.push(
        ...within(panel)
          .queryAllByTestId(/^gear-card-/)
          .map(el => el.dataset.testid!.replace('gear-card-', ''))
      );
    }
    expect(seen.sort()).toEqual(FIXTURE.map(g => g.key).sort());
  });
});

describe('GearsPage open card', () => {
  it('opens the long-form view from a card and returns to the list on Back', async () => {
    renderPage();
    await openTab(/Explore Features/);
    await userEvent.click(screen.getByTestId('gear-card-mementos'));
    expect(screen.getByTestId('gear-detail-mementos')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('gear-detail-back-btn'));
    expect(screen.queryByTestId('gear-detail-mementos')).not.toBeInTheDocument();
    expect(screen.getByTestId('gear-card-mementos')).toBeInTheDocument();
  });

  it('claims from the open card header on a desktop', async () => {
    renderPage();
    await openTab(/Explore Features/);
    await userEvent.click(screen.getByTestId('gear-card-mementos'));
    const header = screen.getByTestId('gear-detail-mementos');
    await userEvent.click(within(header).getByTestId('gear-claim-mementos'));
    expect(state.mutate.mock.calls[0][0]).toBe('mementos');
    expect(screen.queryByTestId('gear-detail-claim-mementos')).not.toBeInTheDocument();
  });

  it('claims from the strip under the header on a phone', async () => {
    state.isMobile = true;
    renderPage();
    await openTab(/Explore Features/);
    await userEvent.click(screen.getByTestId('gear-card-mementos'));
    await userEvent.click(screen.getByTestId('gear-detail-claim-mementos'));
    expect(state.mutate.mock.calls[0][0]).toBe('mementos');
  });
});
