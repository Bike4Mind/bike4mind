import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../../utils/themes';

// The composer's tools button showed its active-tool icons and "+N" count on models that
// cannot run tools at all, so the chat area advertised a toolset the send would strip
// (resolveTools in useLLMSettingsAssembly returns [] for them). Fast mode was already
// handled; tool-less models were not.

const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// Reassigned per test so one module mock can serve both a tool-capable and a tool-less catalog.
let modelRepo: Array<{ id: string; name: string; supportsTools?: boolean }> = [];

vi.mock('./ToolsSection', () => ({ default: () => <div data-testid="tools-section" /> }));
vi.mock('../../common/ToolIndicators', () => ({ default: () => <div data-testid="tool-indicators" /> }));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: modelRepo }),
}));

import ToolsButton from './ToolsButton';

const baseProps = {
  isMobile: false,
  isTablet: false,
  tools: [] as never[],
  toolMode: 'smart',
  onRollDice: vi.fn(),
  // A selection is present in the store throughout: the point is that it must not be
  // advertised, not that it gets cleared.
  activePrimaryTools: ['web_search'],
  isThinkingActive: true,
  otherActiveToolsCount: 3,
  enabledMcpServers: null,
  availableMcpServers: [] as string[],
  setTools: vi.fn(),
};

describe('ToolsButton active-tool indicators', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it('shows indicators on a tool-capable model in Smart mode', () => {
    modelRepo = [{ id: 'gpt-4o', name: 'GPT-4o', supportsTools: true }];
    render(
      <TestWrapper>
        <ToolsButton {...baseProps} model="gpt-4o" />
      </TestWrapper>
    );
    expect(screen.getByTestId('tool-indicators')).toBeInTheDocument();
  });

  it('hides indicators on a model that does not support tools', () => {
    modelRepo = [{ id: 'gpt-image-1', name: 'GPT Image 1', supportsTools: false }];
    render(
      <TestWrapper>
        <ToolsButton {...baseProps} model="gpt-image-1" />
      </TestWrapper>
    );
    expect(screen.queryByTestId('tool-indicators')).not.toBeInTheDocument();
  });

  it('hides indicators when supportsTools is absent from the catalog entry', () => {
    // Every image row in the seed omits the field rather than setting it false.
    modelRepo = [{ id: 'flux-pro', name: 'Flux Pro' }];
    render(
      <TestWrapper>
        <ToolsButton {...baseProps} model="flux-pro" />
      </TestWrapper>
    );
    expect(screen.queryByTestId('tool-indicators')).not.toBeInTheDocument();
  });

  it('still hides indicators in Fast mode on a tool-capable model', () => {
    modelRepo = [{ id: 'gpt-4o', name: 'GPT-4o', supportsTools: true }];
    render(
      <TestWrapper>
        <ToolsButton {...baseProps} model="gpt-4o" toolMode="fast" />
      </TestWrapper>
    );
    expect(screen.queryByTestId('tool-indicators')).not.toBeInTheDocument();
  });

  it('shows indicators while the catalog is still loading', () => {
    // supportsTools falls back to true on an unknown model, so the icons must not flicker
    // out on first paint before the catalog resolves.
    modelRepo = [];
    render(
      <TestWrapper>
        <ToolsButton {...baseProps} model="gpt-4o" />
      </TestWrapper>
    );
    expect(screen.getByTestId('tool-indicators')).toBeInTheDocument();
  });
});
