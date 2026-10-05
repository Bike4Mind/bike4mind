import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ActiveLakeScopeStrip from './ActiveLakeScopeStrip';
import { DRAFT_LAKE_TOOLTIP } from '@client/app/components/datalake/lakeVisibility';
import { UNSEARCHABLE_LAKE_REASON } from '@client/app/components/datalake/lakeRetrievability';
import { DATA_LAKES, type ManageableDataLakeConfig } from '@bike4mind/common';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const lake = (id: string, name: string, status?: string, retrievable?: boolean) =>
  ({ id, name, status, retrievable, datalakeTag: `datalake:${id}` }) as ManageableDataLakeConfig;

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

  it('lets the not-searched icon receive hover, which the chip start slot blocks by default', () => {
    render(
      <Wrapper>
        <ActiveLakeScopeStrip lakes={[{ ...lake('c', 'Private'), retrievable: false }]} onClear={vi.fn()} />
      </Wrapper>
    );

    const decorator = screen.getByTestId('datalake-active-scope-unsearchable-c').parentElement as HTMLElement;
    expect(decorator).toHaveClass('MuiChip-startDecorator');
    expect(getComputedStyle(decorator).pointerEvents).not.toBe('none');
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

  it('explains a server-labelled draft as a draft, in warning colour, under Not searched', async () => {
    // The server labels an owner's own draft retrievable: false, so this is the shape drafts arrive in.
    render(
      <Wrapper>
        <ActiveLakeScopeStrip
          lakes={[lake('d', 'My draft', 'draft', false), lake('b', 'Live', 'active', true)]}
          onClear={vi.fn()}
        />
      </Wrapper>
    );

    expect(
      within(screen.getByTestId('datalake-active-scope-unsearchable-group')).getByTestId('datalake-active-scope-chip-d')
    ).toHaveClass('MuiChip-colorWarning');
    fireEvent.mouseOver(screen.getByTestId('datalake-active-scope-unsearchable-d'));
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(DRAFT_LAKE_TOOLTIP));
    expect(screen.getByRole('tooltip')).not.toHaveTextContent(UNSEARCHABLE_LAKE_REASON);
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

    // Tooltip names its child via aria-label from `title`, synchronously, so absence needs no timer.
    expect(screen.getByTestId('datalake-active-scope-chip-a')).toHaveAttribute('aria-label', DRAFT_LAKE_TOOLTIP);
    for (const id of ['b', DATA_LAKES[0].id]) {
      expect(screen.getByTestId(`datalake-active-scope-chip-${id}`)).not.toHaveAttribute(
        'aria-label',
        DRAFT_LAKE_TOOLTIP
      );
    }
  });
});
