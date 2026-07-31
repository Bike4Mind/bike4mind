import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';
import SubscriptionTable from './SubscriptionTable';
import { SubscriptionData } from '../types';

// Force the desktop table branch (deterministic; avoids matchMedia in jsdom).
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

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
    <CssVarsProvider>
      <SubscriptionTable subscriptions={subscriptions} planMap={{}} />
    </CssVarsProvider>
  );

describe('SubscriptionTable — user column (regression for #1264)', () => {
  it("renders the owner's username/email from the API `owner` field", () => {
    renderTable([
      baseSub({
        id: 'sub_a',
        owner: { username: 'alice', email: 'alice@example.com', name: 'Alice', _id: 'u1' },
      }),
    ]);

    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Unknown User')).not.toBeInTheDocument();
  });

  it('falls back to "Unknown User" only when the owner is absent', () => {
    renderTable([baseSub({ id: 'sub_b', owner: undefined })]);

    expect(screen.getByText('Unknown User')).toBeInTheDocument();
  });
});
