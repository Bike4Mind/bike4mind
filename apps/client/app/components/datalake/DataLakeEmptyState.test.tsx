import type { ReactNode } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { SxProps } from '@mui/joy/styles/types';
import { getThemeConfig } from '@client/app/utils/themes';
import StorageIcon from '@mui/icons-material/Storage';
import DataLakeEmptyState from './DataLakeEmptyState';

// Custom palette tokens (background.surface2 etc.) need the app theme to resolve.
const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderState = (sx?: SxProps) =>
  render(
    <TestWrapper>
      <DataLakeEmptyState
        icon={<StorageIcon sx={{ fontSize: 18 }} />}
        title="Nothing here"
        sx={sx}
        data-testid="empty-state"
      >
        Some explanatory copy.
      </DataLakeEmptyState>
    </TestWrapper>
  );

describe('DataLakeEmptyState', () => {
  it('renders the title and body', () => {
    renderState();
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Some explanatory copy.')).toBeInTheDocument();
  });

  it('keeps its base styles when no sx is passed', () => {
    renderState();
    expect(getComputedStyle(screen.getByTestId('empty-state')).textAlign).toBe('center');
  });

  // The `sx` prop is typed SxProps, which permits an object, a theme callback, OR an array. The
  // three cases below exist because composing with `...sx` compiles fine but silently drops the
  // latter two - so a caller passing a callback would get no styling and no error.
  it('applies an object sx over the base styles', () => {
    renderState({ paddingTop: '48px' });
    expect(getComputedStyle(screen.getByTestId('empty-state')).paddingTop).toBe('48px');
  });

  it('applies a theme-callback sx', () => {
    renderState(() => ({ paddingTop: '48px' }));
    expect(getComputedStyle(screen.getByTestId('empty-state')).paddingTop).toBe('48px');
  });

  it('applies every entry of an array sx', () => {
    renderState([{ paddingTop: '48px' }, { paddingBottom: '12px' }]);
    const style = getComputedStyle(screen.getByTestId('empty-state'));
    expect(style.paddingTop).toBe('48px');
    expect(style.paddingBottom).toBe('12px');
  });
});
