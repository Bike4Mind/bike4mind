import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../../utils/themes';

vi.mock('./AgentsSection', () => ({
  default: () => <div data-testid="agents-section" />,
}));

import AgentsButton from './AgentsButton';

const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('AgentsButton in a crowded composer row', () => {
  it('keeps its width instead of letting flex squeeze it', () => {
    render(
      <TestWrapper>
        <AgentsButton isMobile={false} isTablet={false} activeAgentsCount={2} />
      </TestWrapper>
    );
    expect(screen.getByTestId('session-agents-dropdown-toggle')).toHaveStyle({ flexShrink: '0' });
  });

  it('names the button with its active count when the tablet layout hides the label', () => {
    render(
      <TestWrapper>
        <AgentsButton isMobile={false} isTablet={true} activeAgentsCount={2} />
      </TestWrapper>
    );
    expect(screen.getByRole('button', { name: 'Agents, 2 active' })).toBeInTheDocument();
  });

  it('names the button "Agents" on a tablet with none active', () => {
    render(
      <TestWrapper>
        <AgentsButton isMobile={false} isTablet={true} activeAgentsCount={0} />
      </TestWrapper>
    );
    expect(screen.getByRole('button', { name: 'Agents' })).toBeInTheDocument();
  });
});
