import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';

import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Tests for the M4 classifier-driven badge. Covers the two render
 * states (active vs dismissed) and the Dismiss click effect on the LLM
 * context's `disableAutoRouteForThisSession` flag.
 *
 * Mocks `useLLM` so the component can be rendered without the real Zustand
 * store / persist middleware. Pattern mirrors `BackgroundAgentBadge.test.tsx`.
 */

const mocks = vi.hoisted(() => ({
  dismissed: false,
  setLLM: vi.fn(),
}));

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (s: { setLLM: typeof mocks.setLLM; disableAutoRouteForThisSession: boolean }) => unknown) =>
    selector({ setLLM: mocks.setLLM, disableAutoRouteForThisSession: mocks.dismissed }),
}));

import AutoRouteBadge from './AutoRouteBadge';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  React.createElement(CssVarsProvider, { theme: appTheme }, children);

beforeEach(() => {
  mocks.dismissed = false;
  mocks.setLLM.mockReset();
});

describe('AutoRouteBadge', () => {
  it('renders the active badge with copy + Dismiss button by default', () => {
    render(<AutoRouteBadge />, { wrapper: Wrapper });
    expect(screen.getByTestId('auto-route-badge')).toBeInTheDocument();
    expect(screen.getByText(/Agent mode auto-engaged/i)).toBeInTheDocument();
    expect(screen.getByTestId('auto-route-badge-dismiss')).toBeInTheDocument();
    // Dismissed chip MUST NOT render in the active state - would imply layout shift.
    expect(screen.queryByTestId('auto-route-badge-dismissed')).not.toBeInTheDocument();
  });

  it('switches to the quieter Chip variant once dismissed', () => {
    mocks.dismissed = true;
    render(<AutoRouteBadge />, { wrapper: Wrapper });
    expect(screen.getByTestId('auto-route-badge-dismissed')).toBeInTheDocument();
    expect(screen.getByText(/auto-routing paused for this session/i)).toBeInTheDocument();
    // Active badge gone - and the dismiss button MUST NOT re-render in the
    // dismissed state, otherwise the user could double-fire the action.
    expect(screen.queryByTestId('auto-route-badge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('auto-route-badge-dismiss')).not.toBeInTheDocument();
  });

  it('calls setLLM({ disableAutoRouteForThisSession: true }) on Dismiss click', () => {
    render(<AutoRouteBadge />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('auto-route-badge-dismiss'));
    expect(mocks.setLLM).toHaveBeenCalledTimes(1);
    expect(mocks.setLLM).toHaveBeenCalledWith({ disableAutoRouteForThisSession: true });
  });

  // The complexity-routed variant must explain that the user's Smart
  // Tools selection was replaced, not just that "research" was detected.
  it('renders the complexity-specific copy when source="complexity"', () => {
    render(<AutoRouteBadge source="complexity" />, { wrapper: Wrapper });
    expect(screen.getByTestId('auto-route-badge')).toBeInTheDocument();
    expect(screen.getByText(/Smart Tools selection was replaced/i)).toBeInTheDocument();
    // Must NOT show the classifier's "multi-step research" wording.
    expect(screen.queryByText(/multi-step research/i)).not.toBeInTheDocument();
  });

  it('renders the classifier copy when source="classifier" (and by default)', () => {
    render(<AutoRouteBadge source="classifier" />, { wrapper: Wrapper });
    expect(screen.getByText(/multi-step research detected/i)).toBeInTheDocument();
    expect(screen.queryByText(/Smart Tools selection was replaced/i)).not.toBeInTheDocument();
  });

  // Dismiss still works from the complexity variant and sets the same
  // session-scoped opt-out (which now also gates the rule-based reroute).
  it('calls setLLM on Dismiss click from the complexity variant', () => {
    render(<AutoRouteBadge source="complexity" />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('auto-route-badge-dismiss'));
    expect(mocks.setLLM).toHaveBeenCalledWith({ disableAutoRouteForThisSession: true });
  });
});
