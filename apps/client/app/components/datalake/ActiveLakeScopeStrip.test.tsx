import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ActiveLakeScopeStrip from './ActiveLakeScopeStrip';
import type { ManageableDataLakeConfig } from '@bike4mind/common';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const lake = (id: string, name: string) => ({ id, name, datalakeTag: `datalake:${id}` }) as ManageableDataLakeConfig;

describe('ActiveLakeScopeStrip', () => {
  it('names every lake in the scope, which the trigger can only count', () => {
    render(
      <Wrapper>
        <ActiveLakeScopeStrip lakes={[lake('a', 'Research Corpus'), lake('b', 'Design Docs')]} onClear={vi.fn()} />
      </Wrapper>
    );

    // "2 lakes" on a collapsed dropdown cannot tell a deliberate scope from a stale one.
    expect(screen.getByTestId('datalake-active-scope-chip-a')).toHaveTextContent('Research Corpus');
    expect(screen.getByTestId('datalake-active-scope-chip-b')).toHaveTextContent('Design Docs');
  });

  it('shows the no-lake scope rather than an empty strip, which reads as nothing set', () => {
    // The tree beside it stays browsable in this state (that is the way out), so the strip is the
    // only place the surface can say retrieval is grounded on nothing.
    render(
      <Wrapper>
        <ActiveLakeScopeStrip lakes={[]} onClear={vi.fn()} />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-active-scope-none')).toHaveTextContent('No data lakes');
    expect(screen.getByTestId('datalake-active-scope-clear-btn')).toBeInTheDocument();
  });

  it('clears back to every reachable lake without reopening the picker', () => {
    const onClear = vi.fn();
    render(
      <Wrapper>
        <ActiveLakeScopeStrip lakes={[lake('a', 'Research Corpus'), lake('b', 'Design Docs')]} onClear={onClear} />
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('datalake-active-scope-clear-btn'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
