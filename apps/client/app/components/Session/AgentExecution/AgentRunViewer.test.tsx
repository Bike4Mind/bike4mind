import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useAgentExecutionStore, type ParentExecution } from '@client/app/stores/useAgentExecutionStore';

const ws = vi.hoisted(() => ({ readyState: 1 /* OPEN */, sendJsonMessage: vi.fn() }));

vi.mock('@client/app/contexts/WebsocketContext', () => ({
  ReadyState: { UNINSTANTIATED: -1, CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useWebsocket: () => ({ readyState: ws.readyState, sendJsonMessage: ws.sendJsonMessage }),
}));
// Avoids loading the full route tree through useAgentExecution.
vi.mock('@client/app/router', () => ({ router: { navigate: vi.fn() } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, ...rest }: { to: string; search: { expand: string } }) => (
    <a href={`${to}?expand=${search.expand}`} {...rest} />
  ),
}));
vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: () => true }));

import AgentRunViewer from './AgentRunViewer';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderViewer = (executionId = 'run-1') =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AgentRunViewer executionId={executionId} />
    </CssVarsProvider>
  );

const sent = () => ws.sendJsonMessage.mock.calls.map(c => c[0] as Record<string, unknown>);

/** What the `reconnect_result` handler leaves in the store once a subscribe is answered. */
const seed = (overrides: Partial<ParentExecution>) =>
  act(() => {
    useAgentExecutionStore.setState(state => ({
      viewedExecutionIds: { ...state.viewedExecutionIds, 'run-1': 'found' },
      executions: {
        'run-1': {
          executionId: 'run-1',
          status: 'running',
          iterations: [],
          totalCreditsUsed: 0,
          childExecutions: {},
          startedAt: Date.now(),
          lastEventAt: Date.now(),
          lastKnownIteration: 0,
          ...overrides,
        },
      },
    }));
  });

beforeEach(() => {
  ws.readyState = 1;
  ws.sendJsonMessage.mockClear();
  useAgentExecutionStore.getState().clearAll();
});

describe('AgentRunViewer', () => {
  it('subscribes on mount and shows a loader until the snapshot arrives', () => {
    renderViewer();
    expect(sent()).toEqual([expect.objectContaining({ command: 'subscribe', executionId: 'run-1' })]);
    expect(screen.getByTestId('agent-run-viewer-loading')).toBeTruthy();
    expect(screen.getByTestId('agent-run-viewer-history-link').getAttribute('href')).toBe(
      '/agent-executions?expand=run-1'
    );
  });

  it('subscribes once the socket comes up, not before', () => {
    ws.readyState = 3;
    const { rerender } = renderViewer();
    expect(sent()).toEqual([]);
    ws.readyState = 1;
    rerender(
      <CssVarsProvider theme={appTheme}>
        <AgentRunViewer executionId="run-1" />
      </CssVarsProvider>
    );
    expect(sent().map(m => m.command)).toEqual(['subscribe']);
  });

  it('shows "Run not found" when the server refuses or has no such run', () => {
    renderViewer();
    act(() => useAgentExecutionStore.getState().setViewed('run-1', 'not_found'));
    expect(screen.getByTestId('agent-run-viewer-not-found').textContent).toBe('Run not found');
  });

  it('renders streamed steps of a running run', () => {
    renderViewer();
    seed({
      iterations: [
        {
          iteration: 0,
          step: { type: 'thought', content: 'Looking at the inbox', metadata: { timestamp: 1, iteration: 0 } },
          isComplete: false,
          receivedAt: 1,
        },
      ],
    });
    expect(screen.getByTestId('iteration-stream-run-1')).toBeTruthy();
    expect(screen.getByText(/Looking at the inbox/)).toBeTruthy();
  });

  it('shows the confidence gate card for a paused run', () => {
    renderViewer();
    seed({ status: 'paused', pendingGate: { iteration: 0, confidence: 0.2, reason: 'Unsure', requestedAt: 1 } });
    expect(screen.getByTestId('confidence-gate-card-run-1')).toBeTruthy();
  });

  it('shows the permission card for a run awaiting permission', () => {
    renderViewer();
    seed({
      status: 'awaiting_permission',
      pendingPermission: { toolName: 'web_search', toolInput: {}, iteration: 0, requestedAt: 1 },
    });
    expect(screen.getByTestId('permission-card-run-1')).toBeTruthy();
  });

  it('shows the final answer and credits of a completed run', () => {
    renderViewer();
    seed({
      status: 'completed',
      answer: 'All done',
      totalCreditsUsed: 12,
      iterations: [
        {
          iteration: 0,
          step: { type: 'thought', content: 'Checking', metadata: { timestamp: 1, iteration: 0 } },
          isComplete: false,
          receivedAt: 1,
        },
      ],
    });
    expect(screen.getByTestId('iteration-stream-run-1-final-answer').textContent).toContain('All done');
    expect(screen.getByTestId('credit-counter-run-1').textContent).toContain('12');
  });

  it('shows the failure reason of a failed run', () => {
    renderViewer();
    seed({ status: 'failed', failureReason: 'max_handoffs_exceeded' });
    expect(screen.getByTestId('iteration-stream-run-1-failure').textContent).toContain('max_handoffs_exceeded');
  });

  it('sends abort for this run from the abort button', () => {
    renderViewer();
    seed({});
    fireEvent.click(screen.getByTestId('agent-abort-run-1'));
    expect(sent()).toContainEqual({ action: 'agent_execute', command: 'abort', executionId: 'run-1' });
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderViewer();
    seed({});
    ws.sendJsonMessage.mockClear();
    unmount();
    expect(sent()).toEqual([{ action: 'agent_execute', command: 'unsubscribe', executionId: 'run-1' }]);
  });
});
