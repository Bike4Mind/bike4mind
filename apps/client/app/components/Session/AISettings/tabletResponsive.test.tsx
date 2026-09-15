import React from 'react';
import { render, renderHook, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../../utils/themes';
import { useIsMobile, useIsTablet } from '@client/app/hooks/useIsMobile';

// Regression coverage for the tablet (~600-900px) layout bug: the composer
// AI-settings buttons must go icon-only below the `md` breakpoint instead of
// truncating their labels ("Agents" -> "Age", model chip -> "Claude...").
// jsdom has no layout engine, so we drive responsiveness through `matchMedia`
// (the same source `useMediaQuery` reads) rather than asserting computed CSS.

const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// Resolve MUI `max-width` media queries against a fixed viewport width so
// breakpoints.down('sm') (<600) and down('md') (<900) evaluate correctly.
function setViewportWidth(width: number) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const match = /max-width:\s*([\d.]+)/.exec(query);
    const max = match ? parseFloat(match[1]) : Infinity;
    return {
      matches: width <= max,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  });
}

// Stub heavy children so the buttons render in isolation (their dropdown/modal
// bodies pull in unrelated context chains we don't need for label assertions).
vi.mock('./ToolsSection', () => ({ default: () => <div data-testid="tools-section" /> }));
vi.mock('../../common/ToolIndicators', () => ({ default: () => <div data-testid="tool-indicators" /> }));
vi.mock('./AgentsSection', () => ({ default: () => <div data-testid="agents-section" /> }));
vi.mock('../../common/AgentsCountBadge', () => ({ default: () => <div data-testid="agents-count-badge" /> }));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [{ id: 'gpt-4o', name: 'GPT-4o', supportsTools: true }] }),
}));
vi.mock('@client/app/components/Briefcase/BriefcasePanel', () => ({
  BriefcasePanel: () => <div data-testid="briefcase-panel" />,
}));

import ToolsButton from './ToolsButton';
import AgentsButton from './AgentsButton';
import BriefcaseButton from './BriefcaseButton';

const TABLET = 768;
const DESKTOP = 1200;

const toolsProps = {
  isMobile: false,
  tools: [] as never[],
  toolMode: 'smart',
  model: 'gpt-4o',
  onRollDice: vi.fn(),
  activePrimaryTools: [] as string[],
  isThinkingActive: false,
  otherActiveToolsCount: 0,
  enabledMcpServers: null,
  availableMcpServers: [] as string[],
  setTools: vi.fn(),
};

describe('useIsMobile / useIsTablet breakpoints', () => {
  afterEach(() => vi.restoreAllMocks());

  it('treats 768px as tablet (not mobile)', () => {
    setViewportWidth(TABLET);
    const { result: mobile } = renderHook(() => useIsMobile(), { wrapper: TestWrapper });
    const { result: tablet } = renderHook(() => useIsTablet(), { wrapper: TestWrapper });
    expect(mobile.current).toBe(false);
    expect(tablet.current).toBe(true);
  });

  it('treats 1200px as desktop (neither mobile nor tablet)', () => {
    setViewportWidth(DESKTOP);
    const { result: mobile } = renderHook(() => useIsMobile(), { wrapper: TestWrapper });
    const { result: tablet } = renderHook(() => useIsTablet(), { wrapper: TestWrapper });
    expect(mobile.current).toBe(false);
    expect(tablet.current).toBe(false);
  });
});

describe('ToolsButton tablet behavior', () => {
  beforeEach(() => setViewportWidth(TABLET));
  afterEach(() => vi.restoreAllMocks());

  it('hides the "Tools" label when isTablet (icon-only)', () => {
    render(
      <TestWrapper>
        <ToolsButton {...toolsProps} isTablet />
      </TestWrapper>
    );
    expect(screen.queryByText('Tools')).not.toBeInTheDocument();
    // Trigger still present (icon-only)
    expect(screen.getByTestId('session-tools-dropdown-toggle')).toBeInTheDocument();
  });

  it('shows the "Tools" label when not tablet (desktop)', () => {
    setViewportWidth(DESKTOP);
    render(
      <TestWrapper>
        <ToolsButton {...toolsProps} isTablet={false} />
      </TestWrapper>
    );
    expect(screen.getByText('Tools')).toBeInTheDocument();
  });
});

describe('AgentsButton tablet behavior', () => {
  beforeEach(() => setViewportWidth(TABLET));
  afterEach(() => vi.restoreAllMocks());

  it('hides the "Agents" label when isTablet (icon-only)', () => {
    render(
      <TestWrapper>
        <AgentsButton isMobile={false} isTablet activeAgentsCount={0} />
      </TestWrapper>
    );
    expect(screen.queryByText('Agents')).not.toBeInTheDocument();
  });

  it('shows the "Agents" label when not tablet (desktop)', () => {
    setViewportWidth(DESKTOP);
    render(
      <TestWrapper>
        <AgentsButton isMobile={false} isTablet={false} activeAgentsCount={0} />
      </TestWrapper>
    );
    expect(screen.getByText('Agents')).toBeInTheDocument();
  });
});

describe('BriefcaseButton tablet behavior', () => {
  beforeEach(() => setViewportWidth(TABLET));
  afterEach(() => vi.restoreAllMocks());

  it('hides the "Briefcase" label when isTablet (icon-only)', () => {
    render(
      <TestWrapper>
        <BriefcaseButton isMobile={false} isTablet />
      </TestWrapper>
    );
    expect(screen.queryByText('Briefcase')).not.toBeInTheDocument();
    // Trigger still present (icon-only dropdown, not the mobile modal)
    expect(screen.getByTestId('briefcase-toggle')).toBeInTheDocument();
  });

  it('shows the "Briefcase" label when not tablet (desktop)', () => {
    setViewportWidth(DESKTOP);
    render(
      <TestWrapper>
        <BriefcaseButton isMobile={false} isTablet={false} />
      </TestWrapper>
    );
    expect(screen.getByText('Briefcase')).toBeInTheDocument();
  });
});
