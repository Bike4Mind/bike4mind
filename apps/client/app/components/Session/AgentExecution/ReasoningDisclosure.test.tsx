import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Covers the `defaultExpanded` deep-link landing and the `showFinalAnswer`
 * behavior the focused `/agent-executions?expand=` panel relies on. The trace hook is
 * mocked (configurable via `mocks.trace`) and IterationStream is stubbed to a marker so
 * these stay focused unit tests - no network, no real trace rendering.
 */
const mocks = vi.hoisted(() => ({
  trace: { data: undefined as unknown, isLoading: true, isError: false },
}));

vi.mock('@client/app/hooks/data/agentExecutions', () => ({
  useAgentExecutionTrace: () => mocks.trace,
}));
vi.mock('./IterationStream', () => ({
  default: () => React.createElement('div', { 'data-testid': 'iteration-stream' }),
}));

import ReasoningDisclosure from './ReasoningDisclosure';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  React.createElement(CssVarsProvider, { theme: appTheme }, children);

const finalAnswerOnly = { steps: [{ type: 'final_answer', content: 'done' }], children: [], answer: 'the result' };

beforeEach(() => {
  mocks.trace = { data: undefined, isLoading: true, isError: false };
});

describe('ReasoningDisclosure defaultExpanded', () => {
  it('renders collapsed by default', () => {
    render(<ReasoningDisclosure agentExecutionId="exec-collapsed" sessionId="s1" />, { wrapper: Wrapper });
    expect(screen.getByText('Show reasoning')).toBeInTheDocument();
    expect(screen.queryByText('Loading reasoning trace…')).not.toBeInTheDocument();
  });

  it('renders expanded (and starts hydrating) when defaultExpanded is set', () => {
    render(<ReasoningDisclosure agentExecutionId="exec-expanded" sessionId="s1" defaultExpanded />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('Hide reasoning')).toBeInTheDocument();
    expect(screen.getByText('Loading reasoning trace…')).toBeInTheDocument();
  });
});

describe('ReasoningDisclosure showFinalAnswer (focused panel)', () => {
  it('treats a final-answer-only run as empty when the answer is hidden (Quest-bubble default)', () => {
    mocks.trace = { data: finalAnswerOnly, isLoading: false, isError: false };
    render(<ReasoningDisclosure agentExecutionId="exec-quest" sessionId="s1" defaultExpanded />, { wrapper: Wrapper });
    expect(screen.getByText('No reasoning steps recorded for this run.')).toBeInTheDocument();
    expect(screen.queryByTestId('iteration-stream')).not.toBeInTheDocument();
  });

  it('renders the trace (so the answer shows) for a final-answer-only run when showFinalAnswer is set', () => {
    mocks.trace = { data: finalAnswerOnly, isLoading: false, isError: false };
    render(<ReasoningDisclosure agentExecutionId="exec-focused" sessionId="s1" defaultExpanded showFinalAnswer />, {
      wrapper: Wrapper,
    });
    expect(screen.queryByText('No reasoning steps recorded for this run.')).not.toBeInTheDocument();
    expect(screen.getByTestId('iteration-stream')).toBeInTheDocument();
  });
});
