import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';

vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

import { GearsDiscoveryModal } from './GearsDiscoveryModal';

const appTheme = extendTheme({ ...getThemeConfig() });

const gear = (key: string, credits = 250): GearStatus =>
  ({
    key,
    kind: 'skill',
    unlocked: false,
    credits,
    title: `${key} title`,
    tagline: '',
    intro: `${key} intro`,
    cta: `Try ${key}`,
    ctaAction: `navigate:/${key}`,
  }) as GearStatus;

const handlers = {
  onClose: vi.fn(),
  onDismissForever: vi.fn(),
  onSeeAll: vi.fn(),
  onSelect: vi.fn(),
};

const renderModal = (gears: GearStatus[], open = true) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <GearsDiscoveryModal open={open} gears={gears} {...handlers} />
    </CssVarsProvider>
  );

beforeEach(() => Object.values(handlers).forEach(fn => fn.mockReset()));

describe('GearsDiscoveryModal', () => {
  it('renders the heading, the credit note and one card per gear with its CTA and reward', () => {
    renderModal([gear('agents', 1000), gear('image'), gear('mcp')]);
    const modal = screen.getByTestId('gears-discovery-modal');
    expect(within(modal).getByText("Don't miss these features")).toBeTruthy();
    expect(within(modal).getByText(/one-time credit bonus/)).toBeTruthy();
    expect(within(modal).getByTestId('gear-card-agents')).toBeTruthy();
    expect(within(modal).getByTestId('gear-cta-agents').textContent).toContain('Try agents');
    expect(within(modal).getByTestId('gear-reward-agents').textContent).toContain('1,000');
    expect(within(modal).queryByTestId('gear-claim-agents')).toBeNull();
  });

  it('selecting a card reports the gear and its position', async () => {
    renderModal([gear('agents'), gear('image'), gear('mcp')]);
    await userEvent.click(screen.getByTestId('gear-card-image'));
    expect(handlers.onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'image' }), 1);
  });

  it('activates a card from the keyboard', async () => {
    renderModal([gear('agents'), gear('image'), gear('mcp')]);
    screen.getByTestId('gear-card-mcp').focus();
    await userEvent.keyboard('{Enter}');
    expect(handlers.onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: 'mcp' }), 2);
  });

  it('wires the footer and close controls', async () => {
    renderModal([gear('agents'), gear('image'), gear('mcp')]);
    await userEvent.click(screen.getByTestId('gears-discovery-never-btn'));
    expect(handlers.onDismissForever).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('gears-discovery-see-all-btn'));
    expect(handlers.onSeeAll).toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('gears-discovery-close-btn'));
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    renderModal([gear('agents'), gear('image'), gear('mcp')], false);
    expect(screen.queryByTestId('gears-discovery-modal')).toBeNull();
  });
});
