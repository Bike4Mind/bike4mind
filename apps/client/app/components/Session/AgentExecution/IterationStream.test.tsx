import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type {
  ChildExecution,
  IterationStep,
  ParentExecution,
  PendingPermission,
} from '@client/app/stores/useAgentExecutionStore';

// Hoisted mock state for the agent execution store. The component reads its
// execution via `useAgentExecutionStore(selectExecution(id))`; SubagentStepNest
// (mounted by IterationStream when delegate_to_agent action steps appear)
// reads directly via `state.executions[parentId]?.childExecutions[childId]`,
// so we expose the full execution under `state.executions` too.
const mocks = vi.hoisted(() => ({
  execution: undefined as ParentExecution | undefined,
}));

vi.mock('@client/app/stores/useAgentExecutionStore', () => {
  // The real selector returns `executions[id]`; we just hand back the fixture.
  const selectExecution = () => () => mocks.execution;
  // Provide a state object that satisfies all three subscription shapes used
  // under this render tree: `selectExecution(id)`, the inline lookup in
  // SubagentStepNest, and PermissionCard's setter accessor.
  const useAgentExecutionStore = (selector: (s: unknown) => unknown) =>
    selector({
      executions: mocks.execution ? { [mocks.execution.executionId]: mocks.execution } : {},
      setPendingPermission: vi.fn(),
    });
  // AbortButton (mounted via IterationStream) imports `isActiveStatus` from
  // this module; provide the same predicate the real store exports so the
  // button renders for in-flight executions.
  const ACTIVE_STATUSES = new Set<string>([
    'pending',
    'running',
    'continuing',
    'awaiting_permission',
    'awaiting_subagent',
    'awaiting_dag_children',
    'paused',
  ]);
  const isActiveStatus = (status: string) => ACTIVE_STATUSES.has(status);
  return { useAgentExecutionStore, selectExecution, isActiveStatus };
});

vi.mock('@client/app/hooks/useAgentExecution', () => ({
  useAgentExecutionDispatch: () => ({
    abortExecution: vi.fn(),
    respondToPermission: vi.fn(),
  }),
}));

import { groupByIteration } from './IterationStream';
import IterationStream from './IterationStream';

const step = (iteration: number, receivedAt: number, content = 'noop'): IterationStep => ({
  iteration,
  step: { type: 'thought', content, metadata: { timestamp: receivedAt } },
  isComplete: false,
  receivedAt,
});

describe('groupByIteration', () => {
  it('returns an empty array for no items', () => {
    expect(groupByIteration([])).toEqual([]);
  });

  it('groups consecutive items by iteration number', () => {
    const items = [step(0, 1), step(0, 2), step(1, 3), step(1, 4)];
    const groups = groupByIteration(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].iteration).toBe(0);
    expect(groups[0].steps).toHaveLength(2);
    expect(groups[1].iteration).toBe(1);
    expect(groups[1].steps).toHaveLength(2);
  });

  it('groups out-of-order arrivals back together and sorts by iteration', () => {
    // Interleaved arrivals can happen if the server retries a step after a
    // transient failure - group key is the iteration number, not the order.
    const items = [step(1, 10), step(0, 11), step(1, 12), step(0, 13)];
    const groups = groupByIteration(items);
    expect(groups.map(g => g.iteration)).toEqual([0, 1]);
    expect(groups[0].steps).toHaveLength(2);
    expect(groups[1].steps).toHaveLength(2);
  });

  it('preserves insertion order of steps within a group', () => {
    const items = [step(0, 1, 'first'), step(0, 2, 'second'), step(0, 3, 'third')];
    const [group] = groupByIteration(items);
    expect(group.steps.map(s => s.step.content)).toEqual(['first', 'second', 'third']);
  });
});

// MUI Joy components rely on the project theme tokens (e.g. `background.surface2`)
// which aren't available under the bare CssVarsProvider - wrap with the real
// theme so the Alert and Chip components don't throw at render time.
const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const EXECUTION_ID = 'exec-render-1';

const makeExecution = (overrides: Partial<ParentExecution> = {}): ParentExecution => ({
  executionId: EXECUTION_ID,
  sessionId: 'sess-1',
  status: 'running',
  iterations: [],
  totalCreditsUsed: 0,
  childExecutions: {},
  startedAt: Date.now(),
  lastEventAt: Date.now(),
  ...overrides,
});

const PENDING: PendingPermission = {
  toolName: 'delegate_to_agent',
  toolInput: '{"agent":"Research"}',
  iteration: 0,
  requestedAt: Date.now(),
};

describe('IterationStream — render', () => {
  it('returns null when no execution exists for the id', () => {
    mocks.execution = undefined;
    const { container } = render(
      <TestWrapper>
        <IterationStream executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(container.firstChild).toBeNull();
  });

  it('mounts the PermissionCard when execution.pendingPermission is set', () => {
    // Regression guard for the wiring at IterationStream.tsx:83 - the parent
    // unconditionally renders <PermissionCard executionId={...} /> and the
    // card itself decides whether to show based on the store. This test
    // proves the parent passes the right id and the card actually mounts
    // when the fixture has pendingPermission set.
    mocks.execution = makeExecution({
      status: 'awaiting_permission',
      pendingPermission: PENDING,
    });
    render(
      <TestWrapper>
        <IterationStream executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    expect(screen.getByTestId(`iteration-stream-${EXECUTION_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`permission-card-${EXECUTION_ID}`)).toBeInTheDocument();
    // Status pill reflects the awaiting_permission state
    expect(screen.getByText('Awaiting permission')).toBeInTheDocument();
  });

  it('does not mount the PermissionCard when pendingPermission is undefined', () => {
    mocks.execution = makeExecution({ status: 'running' });
    render(
      <TestWrapper>
        <IterationStream executionId={EXECUTION_ID} />
      </TestWrapper>
    );

    expect(screen.getByTestId(`iteration-stream-${EXECUTION_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`permission-card-${EXECUTION_ID}`)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// stepToChildId - ordinal matching between `delegate_to_agent` action steps
// and child executions. The server emits `subagent_started` in the same order
// `delegate_to_agent` fires; the cursor must advance through ALL children
// (including background) so a foreground delegate following a background one
// still maps to its own child.
// ---------------------------------------------------------------------------

const delegateAction = (iteration: number, receivedAt: number): IterationStep => ({
  iteration,
  step: {
    type: 'action',
    content: 'delegating to subagent',
    metadata: { toolName: 'delegate_to_agent' },
  },
  isComplete: false,
  receivedAt,
});

const makeChild = (overrides: Partial<ChildExecution> & Pick<ChildExecution, 'executionId'>): ChildExecution => ({
  agentName: 'Subagent',
  status: 'running',
  iterations: [],
  ...overrides,
});

describe('IterationStream — stepToChildId ordinal mapping', () => {
  it('renders a single nest for one foreground delegate', () => {
    mocks.execution = makeExecution({
      iterations: [delegateAction(0, 100)],
      childExecutions: {
        'fg-1': makeChild({ executionId: 'fg-1', agentName: 'Researcher' }),
      },
    });
    render(
      <TestWrapper>
        <IterationStream executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(screen.getByTestId('subagent-nest-fg-1')).toBeInTheDocument();
  });

  it('renders no nest for a background-only delegate (badge owns it)', () => {
    mocks.execution = makeExecution({
      iterations: [delegateAction(0, 100)],
      childExecutions: {
        'bg-1': makeChild({ executionId: 'bg-1', agentName: 'Researcher', isBackground: true }),
      },
    });
    render(
      <TestWrapper>
        <IterationStream executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(screen.queryByTestId('subagent-nest-bg-1')).not.toBeInTheDocument();
  });

  it('maps fg after bg correctly — cursor advances through bg children', () => {
    // Regression for a latent bug fix: the previous implementation indexed into
    // `nonBackgroundChildren[cursor]` so the bg's slot was consumed by the fg
    // child, then the fg action found no child and dropped silently.
    mocks.execution = makeExecution({
      iterations: [delegateAction(0, 100), delegateAction(1, 200)],
      childExecutions: {
        'bg-1': makeChild({ executionId: 'bg-1', agentName: 'BgWorker', isBackground: true }),
        'fg-1': makeChild({ executionId: 'fg-1', agentName: 'FgWorker' }),
      },
    });
    render(
      <TestWrapper>
        <IterationStream executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(screen.queryByTestId('subagent-nest-bg-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('subagent-nest-fg-1')).toBeInTheDocument();
  });

  it('maps fg before bg correctly — fg renders, bg ignored at the second slot', () => {
    mocks.execution = makeExecution({
      iterations: [delegateAction(0, 100), delegateAction(1, 200)],
      childExecutions: {
        'fg-1': makeChild({ executionId: 'fg-1', agentName: 'FgWorker' }),
        'bg-1': makeChild({ executionId: 'bg-1', agentName: 'BgWorker', isBackground: true }),
      },
    });
    render(
      <TestWrapper>
        <IterationStream executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(screen.getByTestId('subagent-nest-fg-1')).toBeInTheDocument();
    expect(screen.queryByTestId('subagent-nest-bg-1')).not.toBeInTheDocument();
  });

  it('does not crash or render a nest when the action arrives before the child', () => {
    // Race condition: the parent's action step lands first, the subagent_started
    // event lands a tick later. The Nth-action lookup should fail safely.
    mocks.execution = makeExecution({
      iterations: [delegateAction(0, 100)],
      childExecutions: {},
    });
    render(
      <TestWrapper>
        <IterationStream executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(screen.getByTestId(`iteration-stream-${EXECUTION_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(/^subagent-nest-/)).not.toBeInTheDocument();
  });
});

describe('IterationStream — delegate-misalignment warning gating', () => {
  const ORDINAL_WARN = '[IterationStream] delegate action without matching child';

  // A delegate action with no matching child is the transient race during an
  // in-flight delegation - and `awaiting_subagent` / `awaiting_dag_children` are
  // exactly those states. They must count as active (via isActiveStatus), so the
  // dev warning stays silent; it only fires once the run is genuinely terminal.
  it('does NOT warn while the run is active (awaiting_subagent)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.execution = makeExecution({
      status: 'awaiting_subagent',
      iterations: [delegateAction(0, 100)],
      childExecutions: {},
    });
    render(
      <TestWrapper>
        <IterationStream executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(ORDINAL_WARN), expect.anything());
    warn.mockRestore();
  });

  it('warns once the run is terminal (completed) and still misaligned', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.execution = makeExecution({
      status: 'completed',
      iterations: [delegateAction(0, 100)],
      childExecutions: {},
    });
    render(
      <TestWrapper>
        <IterationStream executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ORDINAL_WARN), expect.anything());
    warn.mockRestore();
  });

  it('recomputes on an active→terminal transition with unchanged iterations/children (dep guard)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Hold iterations + childExecutions references CONSTANT across the rerender so
    // the only changed memo input is `status` - proving `execution?.status` is a
    // real dependency (a terminal transition flips status without touching the
    // others, e.g. markCompleted).
    const iterations = [delegateAction(0, 100)];
    const childExecutions = {};

    mocks.execution = makeExecution({ status: 'awaiting_subagent', iterations, childExecutions });
    const { rerender } = render(
      <TestWrapper>
        <IterationStream executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(ORDINAL_WARN), expect.anything());

    mocks.execution = makeExecution({ status: 'completed', iterations, childExecutions });
    rerender(
      <TestWrapper>
        <IterationStream executionId={EXECUTION_ID} />
      </TestWrapper>
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ORDINAL_WARN), expect.anything());
    warn.mockRestore();
  });
});
