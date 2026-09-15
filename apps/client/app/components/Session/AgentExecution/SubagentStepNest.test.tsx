import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ChildExecution } from '@client/app/stores/useAgentExecutionStore';
import SubagentStepNest from './SubagentStepNest';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

function makeChild(overrides: Partial<ChildExecution> = {}): ChildExecution {
  return {
    executionId: 'child-1',
    agentName: 'Researcher',
    status: 'running',
    iterations: [],
    childExecutions: {},
    ...overrides,
  };
}

describe('SubagentStepNest', () => {
  it('renders the agent name heading and an iteration row per group', () => {
    const child = makeChild({
      iterations: [
        { iteration: 0, step: { type: 'thought', content: 'Plan' }, isComplete: false, receivedAt: 0 },
        { iteration: 0, step: { type: 'action', content: 'Calling tool' }, isComplete: false, receivedAt: 1 },
        { iteration: 1, step: { type: 'thought', content: 'Reviewing' }, isComplete: false, receivedAt: 2 },
      ],
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} depth={1} />
      </TestWrapper>
    );
    expect(screen.getByTestId('subagent-nest-child-1')).toBeInTheDocument();
    expect(screen.getByText('Researcher → iteration 1')).toBeInTheDocument();
    expect(screen.getByText('Researcher → iteration 2')).toBeInTheDocument();
  });

  it('surfaces failure reason when child status is failed', () => {
    const child = makeChild({ status: 'failed', error: 'rate limited', isTimeout: false });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} />
      </TestWrapper>
    );
    expect(screen.getByText(/Failed: rate limited/)).toBeInTheDocument();
  });

  it('uses the timeout prefix when isTimeout is set', () => {
    const child = makeChild({ status: 'failed', error: 'no response', isTimeout: true });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} />
      </TestWrapper>
    );
    expect(screen.getByText(/Timed out: no response/)).toBeInTheDocument();
  });

  it('renders a starting/running status line when no iterations have arrived yet', () => {
    const child = makeChild({ status: 'running', iterations: [] });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} />
      </TestWrapper>
    );
    expect(screen.getByText('starting · running')).toBeInTheDocument();
  });

  it('surfaces the latest tool name in the running label instead of a bare iteration count', () => {
    const child = makeChild({
      status: 'running',
      iterations: [
        { iteration: 0, step: { type: 'thought', content: 'Plan' }, isComplete: false, receivedAt: 0 },
        {
          iteration: 0,
          step: { type: 'action', content: '', metadata: { toolName: 'web_search', timestamp: 0 } },
          isComplete: false,
          receivedAt: 1,
        },
        {
          iteration: 1,
          step: { type: 'action', content: '', metadata: { toolName: 'create_issue', timestamp: 2 } },
          isComplete: false,
          receivedAt: 2,
        },
      ],
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} />
      </TestWrapper>
    );
    expect(screen.getByText('creating issue · iter 2')).toBeInTheDocument();
  });

  it('strips MCP server + product prefixes from tool names in the running label', () => {
    const child = makeChild({
      status: 'running',
      iterations: [
        {
          iteration: 0,
          step: { type: 'action', content: '', metadata: { toolName: 'atlassian__jira_search_issues', timestamp: 0 } },
          isComplete: false,
          receivedAt: 0,
        },
      ],
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} />
      </TestWrapper>
    );
    expect(screen.getByText('searching issues · iter 1')).toBeInTheDocument();
  });

  it('renders the server-streamed lastProgress while the child is running', () => {
    const child = makeChild({
      status: 'running',
      lastProgress: 'Searching...',
      iterations: [
        {
          iteration: 0,
          step: { type: 'action', content: '', metadata: { toolName: 'web_search', timestamp: 0 } },
          isComplete: false,
          receivedAt: 0,
        },
      ],
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} />
      </TestWrapper>
    );
    expect(screen.getByText('Searching... · iter 1')).toBeInTheDocument();
  });

  it('renders lastProgress alone before any iteration has arrived', () => {
    const child = makeChild({ status: 'running', lastProgress: 'Working...', iterations: [] });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} />
      </TestWrapper>
    );
    expect(screen.getByText('Working...')).toBeInTheDocument();
  });

  it('does not show lastProgress for terminal statuses', () => {
    const child = makeChild({
      status: 'completed',
      lastProgress: 'Searching...',
      iterations: [
        {
          iteration: 0,
          step: { type: 'action', content: '', metadata: { toolName: 'web_search', timestamp: 0 } },
          isComplete: true,
          receivedAt: 0,
        },
      ],
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} />
      </TestWrapper>
    );
    expect(screen.getByText('1 iteration · completed')).toBeInTheDocument();
  });

  it('falls back to the iteration count when no action has been emitted yet', () => {
    const child = makeChild({
      status: 'running',
      iterations: [{ iteration: 0, step: { type: 'thought', content: 'Plan' }, isComplete: false, receivedAt: 0 }],
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} />
      </TestWrapper>
    );
    expect(screen.getByText('1 iteration · running')).toBeInTheDocument();
  });

  it('keeps the iteration count label for terminal statuses', () => {
    const child = makeChild({
      status: 'completed',
      iterations: [
        {
          iteration: 0,
          step: { type: 'action', content: '', metadata: { toolName: 'web_search', timestamp: 0 } },
          isComplete: true,
          receivedAt: 0,
        },
      ],
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} />
      </TestWrapper>
    );
    expect(screen.getByText('1 iteration · completed')).toBeInTheDocument();
  });
});

// --- Recursive nesting ---

describe('SubagentStepNest — recursive nesting (depth < 3)', () => {
  it('renders a grandchild nest inline when a delegate_to_agent action maps to a grandchild', () => {
    // The ordinal matching pairs the first delegate_to_agent action (receivedAt=5)
    // with the first non-background grandchild by insertion order.
    const grandchild: ChildExecution = {
      executionId: 'grandchild-1',
      agentName: 'LeafResearcher',
      status: 'completed',
      iterations: [
        { iteration: 0, step: { type: 'thought', content: 'Searching...' }, isComplete: true, receivedAt: 10 },
      ],
      childExecutions: {},
    };
    const child = makeChild({
      executionId: 'child-1',
      status: 'completed',
      childExecutions: { 'grandchild-1': grandchild },
      iterations: [
        {
          iteration: 0,
          step: { type: 'action', content: '', metadata: { toolName: 'delegate_to_agent', timestamp: 0 } },
          isComplete: true,
          receivedAt: 5,
        },
      ],
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} depth={1} />
      </TestWrapper>
    );
    // The grandchild's nest should appear inline under the delegate action.
    expect(screen.getByTestId('subagent-nest-grandchild-1')).toBeInTheDocument();
    expect(screen.getByText('LeafResearcher')).toBeInTheDocument();
  });

  it('excludes background grandchildren from inline rendering at depth 1', () => {
    const bgGrandchild: ChildExecution = {
      executionId: 'bg-grandchild-1',
      agentName: 'BackgroundAgent',
      status: 'running',
      iterations: [],
      childExecutions: {},
      isBackground: true,
    };
    const child = makeChild({
      childExecutions: { 'bg-grandchild-1': bgGrandchild },
      iterations: [
        {
          iteration: 0,
          step: { type: 'action', content: '', metadata: { toolName: 'delegate_to_agent', timestamp: 0 } },
          isComplete: false,
          receivedAt: 5,
        },
      ],
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} depth={1} />
      </TestWrapper>
    );
    expect(screen.queryByTestId('subagent-nest-bg-grandchild-1')).not.toBeInTheDocument();
  });
});

// --- Depth cap ---

describe('SubagentStepNest — depth cap at MAX_INLINE_DEPTH (3)', () => {
  function makeGrandchild(id: string, isBackground = false): ChildExecution {
    return {
      executionId: id,
      agentName: `Agent-${id}`,
      status: 'completed',
      iterations: [],
      childExecutions: {},
      isBackground,
    };
  }

  it('shows "View N nested agents" button instead of inline nesting at depth 3', () => {
    const child = makeChild({
      executionId: 'child-deep',
      childExecutions: { 'gc-1': makeGrandchild('gc-1') },
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} depth={3} />
      </TestWrapper>
    );
    expect(screen.getByTestId('subagent-nest-expand-child-deep')).toBeInTheDocument();
    expect(screen.getByText('View 1 nested agent')).toBeInTheDocument();
    // Grandchild is NOT rendered inline yet.
    expect(screen.queryByTestId('subagent-nest-gc-1')).not.toBeInTheDocument();
  });

  it('pluralizes the collapse button label for multiple grandchildren', () => {
    const child = makeChild({
      executionId: 'child-deep',
      childExecutions: {
        'gc-1': makeGrandchild('gc-1'),
        'gc-2': makeGrandchild('gc-2'),
      },
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} depth={3} />
      </TestWrapper>
    );
    expect(screen.getByText('View 2 nested agents')).toBeInTheDocument();
  });

  it('expands grandchildren when the collapse button is clicked', () => {
    const child = makeChild({
      executionId: 'child-deep',
      childExecutions: { 'gc-1': makeGrandchild('gc-1') },
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} depth={3} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('subagent-nest-expand-child-deep'));
    expect(screen.getByTestId('subagent-nest-gc-1')).toBeInTheDocument();
    expect(screen.getByText('Collapse')).toBeInTheDocument();
  });

  it('excludes background grandchildren from the collapse button count', () => {
    const child = makeChild({
      executionId: 'child-deep',
      childExecutions: {
        'gc-fg': makeGrandchild('gc-fg', false),
        'gc-bg': makeGrandchild('gc-bg', true),
      },
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} depth={3} />
      </TestWrapper>
    );
    // Only the 1 foreground grandchild counts.
    expect(screen.getByText('View 1 nested agent')).toBeInTheDocument();
  });

  it('does not show the collapse button when all grandchildren are background', () => {
    const child = makeChild({
      executionId: 'child-deep',
      childExecutions: { 'gc-bg': makeGrandchild('gc-bg', true) },
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} depth={3} />
      </TestWrapper>
    );
    expect(screen.queryByTestId('subagent-nest-expand-child-deep')).not.toBeInTheDocument();
  });

  it('does not show the collapse button when there are no grandchildren', () => {
    const child = makeChild({ executionId: 'child-deep', childExecutions: {} });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} depth={3} />
      </TestWrapper>
    );
    expect(screen.queryByTestId('subagent-nest-expand-child-deep')).not.toBeInTheDocument();
  });

  it('does not show the collapse button at depth 1 even when grandchildren exist', () => {
    // At depth 1, grandchildren render inline - no collapse button needed.
    const child = makeChild({
      executionId: 'child-shallow',
      childExecutions: { 'gc-1': makeGrandchild('gc-1') },
    });
    render(
      <TestWrapper>
        <SubagentStepNest topLevelExecutionId="parent-1" child={child} depth={1} />
      </TestWrapper>
    );
    expect(screen.queryByTestId('subagent-nest-expand-child-shallow')).not.toBeInTheDocument();
  });
});
