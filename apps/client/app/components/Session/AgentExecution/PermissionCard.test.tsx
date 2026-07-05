import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { PendingPermission } from '@client/app/stores/useAgentExecutionStore';

// Hoisted mock state - vi.mock factories run before any imports, so we
// stash the state on a hoisted symbol the factories can reach.
const mocks = vi.hoisted(() => ({
  pendingPermission: undefined as PendingPermission | undefined,
  setPendingPermission: vi.fn(),
  setStatus: vi.fn(),
  respondToPermission: vi.fn(),
}));

vi.mock('@client/app/stores/useAgentExecutionStore', () => {
  // `selectExecution(id)(state)` shape - the component reads
  // `.pendingPermission` off the returned execution.
  const selectExecution = () => () => ({
    pendingPermission: mocks.pendingPermission,
  });
  const useAgentExecutionStore = (selector: (s: unknown) => unknown) =>
    selector({
      // For the `s => s.setPendingPermission` selector path
      setPendingPermission: mocks.setPendingPermission,
      // For the `s => s.setStatus` selector path (optimistic running on approve)
      setStatus: mocks.setStatus,
      // For the `state => selectExecution(id)(state)?.pendingPermission` path -
      // the inner selectExecution closure is also mocked above, so the state
      // object content doesn't need to match the real shape.
    });
  return { useAgentExecutionStore, selectExecution };
});

vi.mock('@client/app/hooks/useAgentExecution', () => ({
  useAgentExecutionDispatch: () => ({
    respondToPermission: mocks.respondToPermission,
  }),
}));

// Import AFTER mocks so the component picks them up.
import PermissionCard from './PermissionCard';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const EXECUTION_ID = 'exec-test-1';

const PENDING: PendingPermission = {
  toolName: 'delegate_to_agent',
  toolInput: JSON.stringify({ agent: 'Research', task: 'Summarize X' }),
  iteration: 1,
  requestedAt: Date.now(),
};

describe('PermissionCard', () => {
  beforeEach(() => {
    mocks.pendingPermission = undefined;
    mocks.setPendingPermission.mockClear();
    mocks.setStatus.mockClear();
    mocks.respondToPermission.mockClear();
  });

  it('renders null when pendingPermission is undefined', () => {
    const { container } = render(
      <TestWrapper>
        <PermissionCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the card with humanized tool name when pendingPermission is set', () => {
    mocks.pendingPermission = PENDING;
    render(
      <TestWrapper>
        <PermissionCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    // Card mounts with the correct test id
    expect(screen.getByTestId(`permission-card-${EXECUTION_ID}`)).toBeInTheDocument();

    // Tool name is humanized (delegate_to_agent -> "Delegate To Agent"),
    // not shown raw - this is the user-facing label.
    expect(screen.getByText('Delegate To Agent')).toBeInTheDocument();
    expect(screen.queryByText('delegate_to_agent')).not.toBeInTheDocument();

    // Iteration is displayed 1-indexed (iteration: 1 -> "iteration 2")
    expect(screen.getByText(/iteration 2/)).toBeInTheDocument();

    // Tool input is pretty-printed (JSON parsed + re-stringified with indent)
    expect(screen.getByText(/"agent": "Research"/)).toBeInTheDocument();
  });

  it('Approve dispatches with approved=true, rememberForSession=false', () => {
    mocks.pendingPermission = PENDING;
    render(
      <TestWrapper>
        <PermissionCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId(`permission-approve-${EXECUTION_ID}`));

    expect(mocks.respondToPermission).toHaveBeenCalledWith(EXECUTION_ID, 'delegate_to_agent', true, false);
    // Optimistic clear fires alongside dispatch
    expect(mocks.setPendingPermission).toHaveBeenCalledWith(EXECUTION_ID, undefined);
  });

  it('Allow for Session dispatches with approved=true, rememberForSession=true', () => {
    mocks.pendingPermission = PENDING;
    render(
      <TestWrapper>
        <PermissionCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId(`permission-allow-session-${EXECUTION_ID}`));

    expect(mocks.respondToPermission).toHaveBeenCalledWith(EXECUTION_ID, 'delegate_to_agent', true, true);
    expect(mocks.setPendingPermission).toHaveBeenCalledWith(EXECUTION_ID, undefined);
  });

  it('Approve optimistically transitions status to running', () => {
    // The post-approval gap (WS permission_response -> server progress event)
    // can be several seconds. Setting status to running optimistically lets
    // IterationStream render its chip-level spinner + "Thinking..." placeholder
    // during that gap so the UI doesn't read as dead.
    mocks.pendingPermission = PENDING;
    render(
      <TestWrapper>
        <PermissionCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId(`permission-approve-${EXECUTION_ID}`));
    expect(mocks.setStatus).toHaveBeenCalledWith(EXECUTION_ID, 'running');
  });

  it('Deny does NOT touch status (server will transition to failed)', () => {
    mocks.pendingPermission = PENDING;
    render(
      <TestWrapper>
        <PermissionCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId(`permission-deny-${EXECUTION_ID}`));
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it('Deny dispatches with approved=false, rememberForSession=false', () => {
    mocks.pendingPermission = PENDING;
    render(
      <TestWrapper>
        <PermissionCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId(`permission-deny-${EXECUTION_ID}`));

    expect(mocks.respondToPermission).toHaveBeenCalledWith(EXECUTION_ID, 'delegate_to_agent', false, false);
    expect(mocks.setPendingPermission).toHaveBeenCalledWith(EXECUTION_ID, undefined);
  });

  it('guards against double-click — second click within the same render does not dispatch', () => {
    // Reproduces the P1 race: Zustand updates are synchronous but React
    // schedules the re-render asynchronously, so a fast second click on a
    // sibling button (e.g. Approve then Deny back-to-back) used to fire two
    // permission_response events. The `responding` ref short-circuits the
    // second handler.
    mocks.pendingPermission = PENDING;
    render(
      <TestWrapper>
        <PermissionCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    fireEvent.click(screen.getByTestId(`permission-approve-${EXECUTION_ID}`));
    fireEvent.click(screen.getByTestId(`permission-deny-${EXECUTION_ID}`));

    expect(mocks.respondToPermission).toHaveBeenCalledTimes(1);
    expect(mocks.respondToPermission).toHaveBeenCalledWith(EXECUTION_ID, 'delegate_to_agent', true, false);
  });

  it('resets the double-click guard between iterations (regression)', () => {
    // Repro: on a multi-iteration run, iteration 1's Approve fires correctly,
    // then `pending` is optimistically cleared (card hides) and re-set when
    // iteration 2's permission arrives. The component does NOT unmount between
    // iterations - only `pending` toggles - so a guard ref that latches `true`
    // on first click would silently swallow iteration 2's Approve click.
    // The fix keys the guard on `pending.requestedAt` and resets it whenever
    // a new permission instance arrives.
    mocks.pendingPermission = PENDING;
    const { rerender } = render(
      <TestWrapper>
        <PermissionCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    // Iteration 1: approve fires
    fireEvent.click(screen.getByTestId(`permission-approve-${EXECUTION_ID}`));
    expect(mocks.respondToPermission).toHaveBeenCalledTimes(1);

    // Optimistic clear - card hides but component stays mounted
    mocks.pendingPermission = undefined;
    rerender(
      <TestWrapper>
        <PermissionCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    // Iteration 2 permission arrives with a fresh requestedAt
    mocks.pendingPermission = {
      ...PENDING,
      iteration: 2,
      requestedAt: PENDING.requestedAt + 1000,
    };
    rerender(
      <TestWrapper>
        <PermissionCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    // Iteration 2: approve must fire (guard reset on new requestedAt)
    fireEvent.click(screen.getByTestId(`permission-approve-${EXECUTION_ID}`));
    expect(mocks.respondToPermission).toHaveBeenCalledTimes(2);
  });

  it('falls back to raw string when toolInput is not valid JSON', () => {
    mocks.pendingPermission = {
      ...PENDING,
      toolInput: 'not valid json {{{',
    };
    render(
      <TestWrapper>
        <PermissionCard executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    expect(screen.getByText('not valid json {{{')).toBeInTheDocument();
  });
});
