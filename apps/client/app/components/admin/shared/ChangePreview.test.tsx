import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { ChangePreview } from './ChangePreview';

const theme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

describe('ChangePreview', () => {
  it('shows the before and after values under derived test ids', () => {
    render(<ChangePreview before="500" after="0" data-testid="preview" />, { wrapper: TestWrapper });

    expect(screen.getByTestId('preview')).toBeInTheDocument();
    expect(screen.getByTestId('preview-before')).toHaveTextContent('500');
    expect(screen.getByTestId('preview-after')).toHaveTextContent('0');
  });

  it('omits the delta chip when none is given', () => {
    render(<ChangePreview before="a" after="b" data-testid="preview" />, { wrapper: TestWrapper });

    expect(screen.queryByTestId('preview-delta')).not.toBeInTheDocument();
  });

  it('shows the delta label and exposes its tone on the status chip', () => {
    render(<ChangePreview before="500" after="0" delta={{ label: '\u2212500', tone: 'bad' }} data-testid="preview" />, {
      wrapper: TestWrapper,
    });

    expect(screen.getByTestId('preview-delta')).toHaveTextContent('\u2212500');
    expect(screen.getByTestId('preview-delta').querySelector('[data-tone]')).toHaveAttribute('data-tone', 'bad');
  });
});
