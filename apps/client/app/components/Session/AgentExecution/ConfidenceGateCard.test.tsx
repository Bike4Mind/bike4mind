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

  it('Proceed sends continue, clears the gate, and optimistically resumes', () => {
    mocks.pendingGate = GATE;
    renderCard();

    fireEvent.click(screen.getByTestId(`confidence-gate-proceed-${EXECUTION_ID}`));

    expect(mocks.respondToGate).toHaveBeenCalledTimes(1);
    expect(mocks.respondToGate).toHaveBeenCalledWith(EXECUTION_ID, 'continue');
    expect(mocks.setPendingGate).toHaveBeenCalledWith(EXECUTION_ID, undefined);
    expect(mocks.setStatus).toHaveBeenCalledWith(EXECUTION_ID, 'running');
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
});
