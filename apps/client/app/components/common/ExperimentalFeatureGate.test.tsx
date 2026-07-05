import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ExperimentalFeatureGate from './ExperimentalFeatureGate';

const mockNavigate = vi.fn();
const mockUseFeatureEnabled = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => mockUseFeatureEnabled(),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const GATE_PROPS = {
  feature: 'enableAgents' as const,
  featureName: 'Agents',
  description: 'Create AI assistants with specialized capabilities.',
};

describe('ExperimentalFeatureGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children when the feature is enabled', () => {
    mockUseFeatureEnabled.mockReturnValue({ isFeatureEnabled: () => true, isLoading: false });

    render(
      <Wrapper>
        <ExperimentalFeatureGate {...GATE_PROPS}>
          <div data-testid="gated-content">protected</div>
        </ExperimentalFeatureGate>
      </Wrapper>
    );

    expect(screen.getByTestId('gated-content')).toBeInTheDocument();
    expect(screen.queryByTestId('experimental-gate-enableAgents')).not.toBeInTheDocument();
  });

  it('renders the gate panel when the feature is disabled', () => {
    mockUseFeatureEnabled.mockReturnValue({ isFeatureEnabled: () => false, isLoading: false });

    render(
      <Wrapper>
        <ExperimentalFeatureGate {...GATE_PROPS}>
          <div data-testid="gated-content">protected</div>
        </ExperimentalFeatureGate>
      </Wrapper>
    );

    expect(screen.getByTestId('experimental-gate-enableAgents')).toBeInTheDocument();
    expect(screen.getByText(/Agents is an experimental feature/)).toBeInTheDocument();
    expect(screen.getByText(GATE_PROPS.description)).toBeInTheDocument();
    expect(screen.queryByTestId('gated-content')).not.toBeInTheDocument();
  });

  it('renders nothing while settings are loading and no loadingFallback is provided', () => {
    mockUseFeatureEnabled.mockReturnValue({ isFeatureEnabled: () => false, isLoading: true });

    const { container } = render(
      <Wrapper>
        <ExperimentalFeatureGate {...GATE_PROPS}>
          <div data-testid="gated-content">protected</div>
        </ExperimentalFeatureGate>
      </Wrapper>
    );

    // Neither the gate panel nor the children should render - prevents a flash
    // of the gate for users who legitimately have the feature on.
    expect(screen.queryByTestId('experimental-gate-enableAgents')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gated-content')).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });

  it('renders loadingFallback while settings are loading when provided', () => {
    mockUseFeatureEnabled.mockReturnValue({ isFeatureEnabled: () => true, isLoading: true });

    render(
      <Wrapper>
        <ExperimentalFeatureGate {...GATE_PROPS} loadingFallback={<div data-testid="gate-loading">loading…</div>}>
          <div data-testid="gated-content">protected</div>
        </ExperimentalFeatureGate>
      </Wrapper>
    );

    // Gate must show the fallback (not the children, not the panel) until
    // hydration resolves - even if isFeatureEnabled would return true.
    expect(screen.getByTestId('gate-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('gated-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('experimental-gate-enableAgents')).not.toBeInTheDocument();
  });

  it('navigates to Profile → Settings when the CTA is clicked', () => {
    mockUseFeatureEnabled.mockReturnValue({ isFeatureEnabled: () => false, isLoading: false });

    render(
      <Wrapper>
        <ExperimentalFeatureGate {...GATE_PROPS}>
          <div>children</div>
        </ExperimentalFeatureGate>
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('experimental-gate-enableAgents-cta'));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/profile', search: { tab: 'settings' } });
  });
});
