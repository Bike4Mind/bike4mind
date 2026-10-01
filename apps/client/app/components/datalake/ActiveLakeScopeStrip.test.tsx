import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

  it('flags a lake chat cannot search, and leaves unlabeled and searchable lakes alone', () => {
    render(
      <Wrapper>
        <ActiveLakeScopeStrip
          lakes={[
            { ...lake('a', 'Mine'), retrievable: true },
            lake('b', 'Unlabeled'),
            { ...lake('c', 'Private'), retrievable: false },
          ]}
          onClear={vi.fn()}
        />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-active-scope-unsearchable-c')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-active-scope-unsearchable-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-active-scope-unsearchable-b')).not.toBeInTheDocument();
    // The unsearchable lake grounds nothing, so it must not sit under "Grounded on".
    const grounded = screen.getByTestId('datalake-active-scope-grounded');
    expect(within(grounded).getByTestId('datalake-active-scope-chip-a')).toBeInTheDocument();
    expect(within(grounded).getByTestId('datalake-active-scope-chip-b')).toBeInTheDocument();
    expect(within(grounded).queryByTestId('datalake-active-scope-chip-c')).not.toBeInTheDocument();
    const notSearched = screen.getByTestId('datalake-active-scope-unsearchable-group');
    expect(within(notSearched).getByTestId('datalake-active-scope-chip-c')).toBeInTheDocument();
    expect(screen.getByText('Not searched')).toBeInTheDocument();
    expect(within(notSearched).getByTestId('datalake-active-scope-clear-btn')).toBeInTheDocument();
  });

  it('says chat can search none of them when every selected lake is unsearchable', () => {
    render(
      <Wrapper>
        <ActiveLakeScopeStrip
          lakes={[
            { ...lake('a', 'One'), retrievable: false },
            { ...lake('b', 'Two'), retrievable: false },
          ]}
          onClear={vi.fn()}
        />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-active-scope-all-unsearchable')).toBeInTheDocument();
    expect(screen.queryByText('Grounded on')).not.toBeInTheDocument();
    expect(screen.queryByText('Not searched')).not.toBeInTheDocument();
  });
});
