import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { SecurityFindingsTable, securitySeverityTone } from './SecurityFindingsTable';

const theme = extendTheme({ ...getThemeConfig() });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);
describe('SecurityFindingsTable', () => {
  it('opens the complete finding from its row and closes the detail', () => {
    render(
      <SecurityFindingsTable
        rows={[
          {
            id: 'one',
            title: 'Synthetic finding',
            severity: 'high',
            description: 'Details',
            recommendation: 'Review configuration',
            documentationUrl: 'javascript:alert(1)',
          },
        ]}
        testId="security-test"
        onRetry={vi.fn()}
      />,
      { wrapper }
    );
    fireEvent.click(screen.getByTestId('security-test-finding-one'));
    expect(screen.getByTestId('security-test-detail')).toHaveTextContent('Review configuration');
    expect(screen.queryByTestId('security-test-guidance-link')).toBeNull();
    fireEvent.click(screen.getByTestId('security-test-close-btn'));
    expect(screen.queryByTestId('security-test-detail')).toBeNull();
  });
  it('uses neutral for low severity rather than healthy and offers an empty retry', () => {
    expect(securitySeverityTone('low')).toBe('neutral');
    expect(securitySeverityTone('high')).toBe('bad');
    const retry = vi.fn();
    render(<SecurityFindingsTable rows={[]} testId="security-test" onRetry={retry} />, { wrapper });
    fireEvent.click(screen.getByTestId('security-test-refresh-btn'));
    expect(retry).toHaveBeenCalledOnce();
  });
});
