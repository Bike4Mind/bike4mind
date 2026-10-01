import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ActiveLakeScopeStrip from './ActiveLakeScopeStrip';
import { DRAFT_LAKE_TOOLTIP } from '@client/app/components/datalake/lakeVisibility';
import { DATA_LAKES, type ManageableDataLakeConfig } from '@bike4mind/common';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const lake = (id: string, name: string, status?: string) =>
  ({ id, name, status, datalakeTag: `datalake:${id}` }) as ManageableDataLakeConfig;

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

  it('removes one lake from the scope without clearing the rest', () => {
    const onRemove = vi.fn();
    render(
      <Wrapper>
        <ActiveLakeScopeStrip
          lakes={[lake('a', 'Research Corpus'), lake('b', 'Design Docs')]}
          onClear={vi.fn()}
          onRemove={onRemove}
        />
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('datalake-active-scope-remove-b'));
    expect(onRemove).toHaveBeenCalledWith('b');
  });

  it('offers no per-lake remove when the host does not handle one', () => {
    render(
      <Wrapper>
        <ActiveLakeScopeStrip lakes={[lake('a', 'Research Corpus'), lake('b', 'Design Docs')]} onClear={vi.fn()} />
      </Wrapper>
    );

    expect(screen.queryByTestId('datalake-active-scope-remove-a')).not.toBeInTheDocument();
  });

  it('explains only a draft lake on hover', async () => {
    render(
      <Wrapper>
        <ActiveLakeScopeStrip
          lakes={[
            lake('a', 'Drafty', 'draft'),
            lake('b', 'Live', 'active'),
            lake('c', 'Legacy'),
            lake(DATA_LAKES[0].id, 'Built-in'),
          ]}
          onClear={vi.fn()}
        />
      </Wrapper>
    );

    await userEvent.hover(screen.getByTestId('datalake-active-scope-chip-a'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(DRAFT_LAKE_TOOLTIP);
    await userEvent.unhover(screen.getByTestId('datalake-active-scope-chip-a'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

    await userEvent.hover(screen.getByTestId('datalake-active-scope-chip-c'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(DRAFT_LAKE_TOOLTIP);
    await userEvent.unhover(screen.getByTestId('datalake-active-scope-chip-c'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

    for (const id of ['b', DATA_LAKES[0].id]) {
      await userEvent.hover(screen.getByTestId(`datalake-active-scope-chip-${id}`));
      // Joy's enterDelay is 100ms; wait past it so absence is not just "not yet".
      await new Promise(r => setTimeout(r, 300));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      await userEvent.unhover(screen.getByTestId(`datalake-active-scope-chip-${id}`));
    }
  });
});
