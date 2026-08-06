/**
 * Locks the User column onto the API's `owner` field. Both layouts are covered
 * because the mobile card and desktop table read the owner independently.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import SubscriptionTable from './SubscriptionTable';
import { SubscriptionData } from '../types';

// Pick the layout branch directly; jsdom has no matchMedia for the real hook.
const mocks = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => mocks.isMobile }));

const appTheme = extendTheme({ ...getThemeConfig() });

const baseSub = (over: Partial<SubscriptionData>): SubscriptionData => ({
  id: 'sub_1',
  userId: 'u1',
  priceId: 'price_1',
  status: 'active',
  canceledAt: null,
  periodStartsAt: new Date('2026-01-01'),
  periodEndsAt: new Date('2026-02-01'),
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ...over,
});

const renderTable = (subscriptions: SubscriptionData[]) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SubscriptionTable subscriptions={subscriptions} planMap={{}} />
    </CssVarsProvider>
  );

describe.each([
  { layout: 'desktop table', isMobile: false },
  { layout: 'mobile card', isMobile: true },
])('SubscriptionTable user column ($layout)', ({ isMobile }) => {
  beforeEach(() => {
    mocks.isMobile = isMobile;
  });

  it("renders the owner's username and email from the API `owner` field", () => {
    renderTable([
      baseSub({
        id: 'sub_a',
        owner: { username: 'alice', email: 'alice@example.com', name: 'Alice', _id: 'u1' },
      }),
    ]);

    expect(screen.getByTestId('subscription-owner-username')).toHaveTextContent('alice');
    expect(screen.getByTestId('subscription-owner-email')).toHaveTextContent('alice@example.com');
  });

  it('falls back to "Unknown User" only when the owner is absent', () => {
    renderTable([baseSub({ id: 'sub_b', owner: undefined })]);

    expect(screen.getByTestId('subscription-owner-username')).toHaveTextContent('Unknown User');
    expect(screen.getByTestId('subscription-owner-email')).toBeEmptyDOMElement();
  });
});
