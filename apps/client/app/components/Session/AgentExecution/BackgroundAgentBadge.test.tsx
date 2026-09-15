import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { BackgroundChildSummary } from '@client/app/stores/useAgentExecutionStore';

const mocks = vi.hoisted(() => ({
  active: [] as BackgroundChildSummary[],
  abort: vi.fn(),
}));

vi.mock('@client/app/stores/useAgentExecutionStore', () => {
  const selectActiveBackgroundChildrenForSession = () => () => mocks.active;
  const useAgentExecutionStore = (selector: (s: unknown) => unknown) => selector({});
  return { useAgentExecutionStore, selectActiveBackgroundChildrenForSession };
});

vi.mock('@client/app/hooks/useAgentExecution', () => ({
  useAgentExecutionDispatch: () => ({ abort: mocks.abort }),
}));

import BackgroundAgentBadge from './BackgroundAgentBadge';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

function makeChild(overrides: Partial<BackgroundChildSummary['child']> = {}): BackgroundChildSummary['child'] {
  return {
    executionId: 'child-1',
    agentName: 'Researcher',
    status: 'running',
    iterations: [],
    isBackground: true,
    ...overrides,
  };
}

describe('BackgroundAgentBadge', () => {
  beforeEach(() => {
    mocks.active = [];
    mocks.abort.mockReset();
  });

  it('renders null when no active background children', () => {
    const { container } = render(
      <TestWrapper>
        <BackgroundAgentBadge sessionId="session-A" />
      </TestWrapper>
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the count when one or more background children are active', () => {
    mocks.active = [
      { parentExecutionId: 'exec-1', child: makeChild({ executionId: 'c1', agentName: 'Researcher' }) },
      { parentExecutionId: 'exec-1', child: makeChild({ executionId: 'c2', agentName: 'Analyst' }) },
    ];
    render(
      <TestWrapper>
        <BackgroundAgentBadge sessionId="session-A" />
      </TestWrapper>
    );
    const badge = screen.getByTestId('background-agent-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAccessibleName('2 background agents running');
    expect(badge).toHaveTextContent('2');
  });

  it('uses singular phrasing for one background child', () => {
    mocks.active = [{ parentExecutionId: 'exec-1', child: makeChild() }];
    render(
      <TestWrapper>
        <BackgroundAgentBadge sessionId="session-A" />
      </TestWrapper>
    );
    expect(screen.getByTestId('background-agent-badge')).toHaveAccessibleName('1 background agent running');
  });

  it('opens the popover listing each child with status and iteration count', () => {
    mocks.active = [
      {
        parentExecutionId: 'exec-1',
        child: makeChild({
          executionId: 'c1',
          agentName: 'Researcher',
          status: 'running',
          iterations: [
            { iteration: 0, step: { type: 'thought', content: '' }, isComplete: false, receivedAt: 0 },
            { iteration: 1, step: { type: 'thought', content: '' }, isComplete: false, receivedAt: 1 },
          ],
        }),
      },
    ];
    render(
      <TestWrapper>
        <BackgroundAgentBadge sessionId="session-A" />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('background-agent-badge'));
    const row = screen.getByTestId('background-agent-row-c1');
    expect(row).toHaveTextContent('Researcher');
    expect(row).toHaveTextContent('2 iterations');
  });

  it('shows "Starting…" when a child has no iterations yet', () => {
    mocks.active = [{ parentExecutionId: 'exec-1', child: makeChild({ executionId: 'c1', iterations: [] }) }];
    render(
      <TestWrapper>
        <BackgroundAgentBadge sessionId="session-A" />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('background-agent-badge'));
    expect(screen.getByTestId('background-agent-row-c1')).toHaveTextContent('Starting');
  });

  it('renders an abort affordance per row and dispatches abort with the child id', () => {
    // An abort affordance per popover row must dispatch against the CHILD's
    // execution id (the bg subagent runs in its own Lambda with its own row),
    // not the parent's.
    mocks.active = [
      { parentExecutionId: 'exec-parent', child: makeChild({ executionId: 'c1', agentName: 'Researcher' }) },
    ];
    render(
      <TestWrapper>
        <BackgroundAgentBadge sessionId="session-A" />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('background-agent-badge'));
    const abortBtn = screen.getByTestId('background-agent-abort-c1');
    expect(abortBtn).toBeInTheDocument();
    expect(abortBtn).toHaveAccessibleName('Stop background agent Researcher');
    fireEvent.click(abortBtn);
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.abort).toHaveBeenCalledWith('c1');
  });
});
