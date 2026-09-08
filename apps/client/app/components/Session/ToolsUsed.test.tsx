import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ToolsUsed from './ToolsUsed';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const openDetails = async () => {
  fireEvent.mouseOver(screen.getByTestId('tools-used'));
  const button = await screen.findByRole('button');
  fireEvent.click(button);
};

describe('ToolsUsed success/failure rendering', async () => {
  it('renders the Response box, not the Error box, on a successful call', async () => {
    render(<ToolsUsed functionCalls={[{ name: 'web_search', returnValue: '5 results found', success: true }]} />, {
      wrapper: TestWrapper,
    });
    await openDetails();

    expect(screen.getByText('Response')).toBeTruthy();
    expect(screen.getByText('5 results found')).toBeTruthy();
    expect(screen.queryByText('Error')).toBeNull();
  });

  it('renders the Error box using returnValue, not the Response box, when success is false', async () => {
    // This is exactly the shape a failed call now records (see recordToolResult):
    // returnValue carries the failure text the model saw, success is false, .error is unset.
    render(
      <ToolsUsed
        functionCalls={[
          { name: 'web_search', returnValue: 'Error processing web_search tool: timeout', success: false },
        ]}
      />,
      { wrapper: TestWrapper }
    );
    await openDetails();

    expect(screen.queryByText('Response')).toBeNull();
    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByText('Error processing web_search tool: timeout')).toBeTruthy();
  });

  it('still renders the Error box from a legacy .error field when success is not set', async () => {
    // Pre-fix data: success/returnValue were never written, only .error existed.
    render(<ToolsUsed functionCalls={[{ name: 'web_search', error: 'legacy failure message' }]} />, {
      wrapper: TestWrapper,
    });
    await openDetails();

    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByText('legacy failure message')).toBeTruthy();
  });

  it('renders both Response and Error only in the ambiguous case of returnValue plus an explicit error, never neither', async () => {
    render(
      <ToolsUsed functionCalls={[{ name: 'web_search', returnValue: 'partial output', error: 'also failed' }]} />,
      { wrapper: TestWrapper }
    );
    await openDetails();

    // success is undefined here (not explicitly false), so the existing "show returnValue" path
    // still applies alongside the explicit error - this is unchanged legacy behavior, not new.
    expect(screen.getByText('Response')).toBeTruthy();
    expect(screen.getByText('Error')).toBeTruthy();
  });
});
