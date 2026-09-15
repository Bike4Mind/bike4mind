import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ParentExecution } from '@client/app/stores/useAgentExecutionStore';

// Hoisted shared state so the mock factory below can read it. vi.mock factories
// run before any module imports - they cannot capture closure variables
// declared after, but they CAN reach a hoisted symbol.
const mocks = vi.hoisted(() => ({
  execution: undefined as ParentExecution | undefined,
}));

vi.mock('@client/app/stores/useAgentExecutionStore', () => {
  // The banner now selects via `state.executions[executionId]` directly
  // (narrow useShallow projection), so the mock surfaces a state with that
  // shape rather than a `selectExecution` helper.
  const useAgentExecutionStore = (selector: (s: unknown) => unknown) => {
    const state = mocks.execution
      ? { executions: { [mocks.execution.executionId]: mocks.execution } }
      : { executions: {} };
    return selector(state);
  };
  return { useAgentExecutionStore };
});

// useShallow is a passthrough in this test - equality semantics don't matter
// for a single render pass, and we want the selector to run against our
// mocked state object.
vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}));

// Import AFTER mocks so the component picks them up.
import ExecutionStatusBanner from './ExecutionStatusBanner';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const EXECUTION_ID = 'exec-banner-1';

function makeExecution(overrides: Partial<ParentExecution>): ParentExecution {
  return {
    executionId: EXECUTION_ID,
    status: 'running',
    iterations: [],
    totalCreditsUsed: 0,
    childExecutions: {},
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    lastKnownIteration: 0,
    ...overrides,
  };
}

describe('ExecutionStatusBanner', () => {
  beforeEach(() => {
    mocks.execution = undefined;
  });

  it('renders null when execution is absent from the store', () => {
    const { container } = render(
      <TestWrapper>
        <ExecutionStatusBanner executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(container.firstChild).toBeNull();
  });

  it.each<['completed' | 'failed' | 'aborted']>([['completed'], ['failed'], ['aborted']])(
    'renders null when execution status is terminal (%s)',
    status => {
      mocks.execution = makeExecution({ status });
      const { container } = render(
        <TestWrapper>
          <ExecutionStatusBanner executionId={EXECUTION_ID} />
        </TestWrapper>
      );
      expect(container.firstChild).toBeNull();
    }
  );

  it('renders null when execution is awaiting permission (PermissionCard takes precedence)', () => {
    mocks.execution = makeExecution({ status: 'awaiting_permission' });
    const { container } = render(
      <TestWrapper>
        <ExecutionStatusBanner executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders "Agent running — iteration N" with 1-indexed iteration', () => {
    mocks.execution = makeExecution({ status: 'running', lastKnownIteration: 2 });
    render(
      <TestWrapper>
        <ExecutionStatusBanner executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(screen.getByTestId(`execution-status-banner-${EXECUTION_ID}`)).toBeInTheDocument();
    expect(screen.getByText('Agent running — iteration 3')).toBeInTheDocument();
  });

  it('renders "iteration 1" during the dispatch gap (lastKnownIteration=0)', () => {
    mocks.execution = makeExecution({ status: 'pending', lastKnownIteration: 0 });
    render(
      <TestWrapper>
        <ExecutionStatusBanner executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(screen.getByText('Agent running — iteration 1')).toBeInTheDocument();
  });

  it('renders "Agent paused" for paused status', () => {
    mocks.execution = makeExecution({ status: 'paused', lastKnownIteration: 5 });
    render(
      <TestWrapper>
        <ExecutionStatusBanner executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(screen.getByText('Agent paused')).toBeInTheDocument();
    expect(screen.queryByText(/iteration/)).not.toBeInTheDocument();
  });
});
