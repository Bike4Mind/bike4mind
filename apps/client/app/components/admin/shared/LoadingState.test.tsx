import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { LoadingState, UpdatingBar } from './LoadingState';

const theme = extendTheme({ ...getThemeConfig() });
const wrap = (node: React.ReactNode) => render(<CssVarsProvider theme={theme}>{node}</CssVarsProvider>);

describe('LoadingState', () => {
  it('announces its label with the default test id', () => {
    wrap(<LoadingState label="Loading things" />);
    const state = screen.getByTestId('admin-loading-state');
    expect(state).toHaveAttribute('role', 'status');
    expect(state).toHaveTextContent('Loading things');
  });

  it('uses a custom test id', () => {
    wrap(<LoadingState label="Loading things" testId="custom-loading" />);
    expect(screen.getByTestId('custom-loading')).toBeInTheDocument();
  });
});

describe('UpdatingBar', () => {
  it('renders the Updating label with default and custom test ids while active', () => {
    wrap(
      <>
        <UpdatingBar active />
        <UpdatingBar active testId="custom-updating" />
      </>
    );
    expect(screen.getByTestId('admin-updating-bar')).toHaveTextContent('Updating');
    expect(screen.getByTestId('custom-updating')).toHaveAttribute('aria-hidden', 'false');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays mounted but hidden and unlabelled when inactive', () => {
    const { container } = wrap(<UpdatingBar active={false} />);
    expect(screen.queryByTestId('admin-updating-bar')).not.toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).toHaveStyle({ visibility: 'hidden' });
  });
});
