import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { PendingGate } from '@client/app/stores/useAgentExecutionStore';

const mocks = vi.hoisted(() => ({
  pendingGate: undefined as PendingGate | undefined,
  setPendingGate: vi.fn(),
  setStatus: vi.fn(),
  respondToGate: vi.fn(),
}));

vi.mock('@client/app/stores/useAgentExecutionStore', () => {
  const selectExecution = () => () => ({ pendingGate: mocks.pendingGate });
  const useAgentExecutionStore = (selector: (s: unknown) => unknown) =>
    selector({
      setPendingGate: mocks.setPendingGate,
      setStatus: mocks.setStatus,
    });
  return { useAgentExecutionStore, selectExecution };
});

vi.mock('@client/app/hooks/useAgentExecution', () => ({
  useAgentExecutionDispatch: () => ({ respondToGate: mocks.respondToGate }),
}));

import ConfidenceGateCard from './ConfidenceGateCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const EXECUTION_ID = 'exec-gate-test';

const GATE: PendingGate = {
  iteration: 2,
  confidence: 0.42,
  reason: 'Iteration confidence 42% below threshold 60%',
  requestedAt: Date.now(),
};

const renderCard = () =>
  render(
    <TestWrapper>
      <ConfidenceGateCard executionId={EXECUTION_ID} />
    </TestWrapper>
  );

describe('ConfidenceGateCard', () => {
  beforeEach(() => {
    mocks.pendingGate = undefined;
    mocks.setPendingGate.mockClear();
    mocks.setStatus.mockClear();
    mocks.respondToGate.mockClear();
  });

  it('renders null when pendingGate is undefined', () => {
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
  });

  it('renders the reason and the 1-indexed iteration for a paused run', () => {
    mocks.pendingGate = GATE;
    renderCard();

    expect(screen.getByTestId(`confidence-gate-card-${EXECUTION_ID}`)).toBeInTheDocument();
    expect(screen.getByText(GATE.reason)).toBeInTheDocument();
    // Wire iteration is 0-indexed; the user-facing label is 1-indexed.
    expect(screen.getByText(/iteration 3/i)).toBeInTheDocument();
  });

  it('Proceed sends continue and clears the gate without claiming the run is live', () => {
    mocks.pendingGate = GATE;
    renderCard();

    fireEvent.click(screen.getByTestId(`confidence-gate-proceed-${EXECUTION_ID}`));

    expect(mocks.respondToGate).toHaveBeenCalledTimes(1);
    expect(mocks.respondToGate).toHaveBeenCalledWith(EXECUTION_ID, 'continue');
    expect(mocks.setPendingGate).toHaveBeenCalledWith(EXECUTION_ID, undefined);
    // Only a server frame may move the run off `paused` - a swept pause must not
    // read "In Progress" on the strength of a click.
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it('Stop sends stop and clears the gate without forcing running', () => {
    mocks.pendingGate = GATE;
    renderCard();

    fireEvent.click(screen.getByTestId(`confidence-gate-stop-${EXECUTION_ID}`));

    expect(mocks.respondToGate).toHaveBeenCalledTimes(1);
    expect(mocks.respondToGate).toHaveBeenCalledWith(EXECUTION_ID, 'stop');
    expect(mocks.setPendingGate).toHaveBeenCalledWith(EXECUTION_ID, undefined);
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it('dispatches at most once per pause even on a double click', () => {
    mocks.pendingGate = GATE;
    renderCard();

    const proceed = screen.getByTestId(`confidence-gate-proceed-${EXECUTION_ID}`);
    fireEvent.click(proceed);
    fireEvent.click(proceed);

    expect(mocks.respondToGate).toHaveBeenCalledTimes(1);
  });

  it('resets the double-click guard between pauses (regression)', () => {
    // A run can pause at the gate more than once. The card does not unmount in
    // between - only `pendingGate` toggles - so a guard ref that latches `true`
    // on the first click would leave the second pause's buttons dead, holding
    // the run's concurrent slot behind an unanswerable card. The effect keys on
    // `pendingGate.requestedAt` so every new pause re-arms the guard.
    mocks.pendingGate = GATE;
    const { rerender } = render(
      <TestWrapper>
        <ConfidenceGateCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId(`confidence-gate-proceed-${EXECUTION_ID}`));
    expect(mocks.respondToGate).toHaveBeenCalledTimes(1);

    // Optimistic clear - card hides but the component stays mounted.
    mocks.pendingGate = undefined;
    rerender(
      <TestWrapper>
        <ConfidenceGateCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    // Second pause arrives with a fresh requestedAt.
    mocks.pendingGate = { ...GATE, iteration: 3, requestedAt: GATE.requestedAt + 1000 };
    rerender(
      <TestWrapper>
        <ConfidenceGateCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId(`confidence-gate-proceed-${EXECUTION_ID}`));
    expect(mocks.respondToGate).toHaveBeenCalledTimes(2);
    expect(mocks.respondToGate).toHaveBeenLastCalledWith(EXECUTION_ID, 'continue');
  });
});
