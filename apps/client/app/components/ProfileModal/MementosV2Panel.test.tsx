import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { V2Belief } from '@client/app/hooks/data/memoryV2';

// The panel is a thin view over two data hooks; we drive it entirely through their return values so the
// tests assert rendering + the two-step shred flow, not React Query internals.
let memoryState: { data?: V2Belief[]; isLoading: boolean; isError: boolean };
const refetch = vi.fn();
const mutate = vi.fn();

vi.mock('@client/app/hooks/data/memoryV2', () => ({
  useV2Memory: () => ({ ...memoryState, refetch }),
  useShredBelief: () => ({ mutate, isPending: false }),
}));

import MementosV2Panel from './MementosV2Panel';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <MementosV2Panel />
    </CssVarsProvider>
  );

const belief = (over: Partial<V2Belief> = {}): V2Belief => ({
  id: 'subject-hmac-1',
  fact: 'User favorite color is green',
  evidenceTier: 'stated',
  confidence: 0.9,
  salience: 'hot',
  derivedFrom: ['ev1'],
  lastAffirmedAt: new Date('2026-07-10').toISOString(),
  ...over,
});

beforeEach(() => {
  memoryState = { data: undefined, isLoading: false, isError: false };
  refetch.mockClear();
  mutate.mockClear();
});

describe('MementosV2Panel', () => {
  it('shows a spinner while loading', () => {
    memoryState = { data: undefined, isLoading: true, isError: false };
    renderPanel();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('offers a retry that refetches when the load errors', () => {
    memoryState = { data: undefined, isLoading: false, isError: true };
    renderPanel();
    fireEvent.click(screen.getByTestId('v2-memory-retry-btn'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when the user has no beliefs', () => {
    memoryState = { data: [], isLoading: false, isError: false };
    renderPanel();
    expect(screen.getByText(/No memories yet/i)).toBeInTheDocument();
  });

  it('renders each belief with its count', () => {
    memoryState = {
      data: [belief(), belief({ id: 'subject-hmac-2', fact: 'User works in pharma', salience: 'cold' })],
      isLoading: false,
      isError: false,
    };
    renderPanel();
    expect(screen.getByText('User favorite color is green')).toBeInTheDocument();
    expect(screen.getByText('User works in pharma')).toBeInTheDocument();
    expect(screen.getByText('2 memories')).toBeInTheDocument();
  });

  it('requires a two-step confirm before shredding, keyed on the belief id', () => {
    memoryState = { data: [belief()], isLoading: false, isError: false };
    renderPanel();

    // First click reveals the confirm affordance; nothing is shredded yet.
    fireEvent.click(screen.getByTestId('v2-belief-delete-btn'));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete forever\?/i)).toBeInTheDocument();

    // Confirming shreds THIS belief's id.
    fireEvent.click(screen.getByTestId('v2-belief-shred-btn'));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toBe('subject-hmac-1');
  });

  it('cancel backs out of the confirm without shredding', () => {
    memoryState = { data: [belief()], isLoading: false, isError: false };
    renderPanel();
    fireEvent.click(screen.getByTestId('v2-belief-delete-btn'));
    fireEvent.click(screen.getByTestId('v2-belief-cancel-btn'));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.queryByText(/Delete forever\?/i)).not.toBeInTheDocument();
  });
});
