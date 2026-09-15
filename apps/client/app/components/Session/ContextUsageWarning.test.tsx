import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ContextUsageWarning } from './ContextUsageWarning';
import type { SessionContextUsage } from '@client/app/hooks/useSessionContextUsage';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const baseUsage: SessionContextUsage = {
  actualInputTokens: 86_000,
  contextLimit: 131_072,
  safeMaxInputTokens: 113_000,
  utilizationPercentage: 76,
  band: 'warning',
  isApproachingLimit: true,
  overflowDetected: false,
  cachingIneffective: false,
};

describe('ContextUsageWarning', () => {
  it('renders nothing when show is false', () => {
    const { container } = render(
      <TestWrapper>
        <ContextUsageWarning show={false} usage={baseUsage} modelName="Grok 4" onDismiss={vi.fn()} />
      </TestWrapper>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the assembled size, model, and percent', () => {
    render(
      <TestWrapper>
        <ContextUsageWarning show usage={baseUsage} modelName="Grok 4" onDismiss={vi.fn()} />
      </TestWrapper>
    );
    const text = screen.getByTestId('context-usage-warning-text').textContent;
    expect(text).toContain('Grok 4');
    expect(text).toContain('86K of 113K');
    expect(text).toContain('76%');
  });

  it('adds the caching cost note only when caching is ineffective', () => {
    const { rerender } = render(
      <TestWrapper>
        <ContextUsageWarning show usage={baseUsage} modelName="Grok 4" onDismiss={vi.fn()} />
      </TestWrapper>
    );
    expect(screen.queryByText(/no caching discount/i)).toBeNull();

    rerender(
      <TestWrapper>
        <ContextUsageWarning
          show
          usage={{ ...baseUsage, cachingIneffective: true }}
          modelName="Grok 4"
          onDismiss={vi.fn()}
        />
      </TestWrapper>
    );
    expect(screen.getByText(/no caching discount/i)).toBeInTheDocument();
  });

  it('fires onDismiss when the close button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <TestWrapper>
        <ContextUsageWarning show usage={baseUsage} modelName="Grok 4" onDismiss={onDismiss} />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('context-usage-warning-dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
