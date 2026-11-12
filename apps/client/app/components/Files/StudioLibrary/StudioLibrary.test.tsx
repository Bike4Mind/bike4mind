import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { useFileBrowserInstance } from '../Browser/instanceContext';

// The browser itself is covered by Content.lockedFilters.test.tsx; this probe pins only what the Library asks of it.
// Sync factory: an async one deadlocks collection through the instanceContext <-> Browser import cycle.
vi.mock('../Browser/Content', () => {
  const ConfigProbe = () => {
    const { config, open } = useFileBrowserInstance();
    return <pre data-testid="probe">{JSON.stringify({ open, ...config })}</pre>;
  };
  return { default: ConfigProbe };
});

import { StudioLibrary } from '.';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderedConfig = () => JSON.parse(screen.getByTestId('probe').textContent ?? '{}');

describe('StudioLibrary', () => {
  it('renders inline, locked to generated media, with stars and the model filter', () => {
    render(
      <TestWrapper>
        <StudioLibrary />
      </TestWrapper>
    );

    expect(screen.getByTestId('studio-library')).toBeInTheDocument();
    expect(renderedConfig()).toMatchObject({
      open: true,
      lockedFilters: { source: 'generated' },
      enableStar: true,
      enableModelFilter: true,
      initialViewMode: 'grid',
    });
  });

  it('starts from the caller initial filters', () => {
    render(
      <TestWrapper>
        <StudioLibrary initialFilters={{ type: 'video', starred: true }} />
      </TestWrapper>
    );

    expect(renderedConfig().initialFilters).toEqual({ type: 'video', starred: true });
  });
});
