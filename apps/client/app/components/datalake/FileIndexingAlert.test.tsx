import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import FileIndexingAlert from './FileIndexingAlert';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('FileIndexingAlert', () => {
  it('renders the alert glyph when the file carries a stored processing error', () => {
    render(
      <TestWrapper>
        <FileIndexingAlert file={{ id: 'f1', error: 'the per-run embedding budget ($0) is exhausted' }} />
      </TestWrapper>
    );
    expect(screen.getByTestId('datalake-file-error-f1')).toBeInTheDocument();
  });

  it('renders nothing for a healthy file', () => {
    const { container } = render(
      <TestWrapper>
        <FileIndexingAlert file={{ id: 'f2', error: undefined }} />
      </TestWrapper>
    );
    expect(container).toBeEmptyDOMElement();
  });
});
