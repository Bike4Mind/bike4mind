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
});
