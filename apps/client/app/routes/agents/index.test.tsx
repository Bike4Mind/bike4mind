import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import AgentsPage from './index';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderWithTheme = (ui: React.ReactElement) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

// Server-side search: empty query returns one agent, any query returns no matches.
// This is the exact shape that exposed the bug - a zero-result search set agents=[].
const getAgentsFromServer = vi.fn((search?: string) =>
  Promise.resolve({ data: search ? [] : [{ id: 'a1', name: 'Alpha' }] })
);
vi.mock('@client/app/utils/agentsAPICalls', () => ({
  getAgentsFromServer: (search?: string) => getAgentsFromServer(search),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { currentCredits: 0 } }),
}));

vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: () => {} }));

// Header renders its rightActions (where the search bar lives) so gating is observable.
vi.mock('@client/app/components/Agent/AgentPageHeader', () => ({
  default: ({ rightActions }: { rightActions?: React.ReactNode }) => <div>{rightActions}</div>,
}));

// Both search-bar variants stub to a plain input wired to handleChange, so we can assert
// the bar's presence (the fix) and drive a query without the real debounced component.
// Defined inline per factory - vi.mock is hoisted, so it can't close over a top-level const.
vi.mock('@client/app/components/Session/SearchBar', () => ({
  default: ({ handleChange }: { handleChange: (v: string) => void }) => (
    <input data-testid="agents-search" onChange={e => handleChange(e.target.value)} />
  ),
}));
vi.mock('@client/app/components/Session/SearchBarWithToggle', () => ({
  default: ({ handleChange }: { handleChange: (v: string) => void }) => (
    <input data-testid="agents-search-toggle" onChange={e => handleChange(e.target.value)} />
  ),
}));
vi.mock('@client/app/components/AgentList/AgentsGrid', () => ({
  default: ({ agents }: { agents: { id: string; name: string }[] }) => (
    <div data-testid="agents-grid">{agents.map(a => a.name).join(',')}</div>
  ),
}));
vi.mock('@client/app/components/AgentList/CreateAgentButton', () => ({ default: () => <button>Create</button> }));
vi.mock('@client/app/components/help', () => ({ ContextHelpButton: () => null }));

describe('AgentsPage — search with no results', () => {
  beforeEach(() => getAgentsFromServer.mockClear());

  it('keeps the search bar and shows a no-results state (not the first-run empty state) on a zero-result search', async () => {
    renderWithTheme(<AgentsPage />);

    // Agent loads: grid + search bar visible.
    expect(await screen.findByTestId('agents-grid')).toHaveTextContent('Alpha');
    expect(screen.getByTestId('agents-search')).toBeInTheDocument();

    // Search for something with no matches. (fireEvent is enough for a bare stub input;
    // userEvent would only add setup ceremony here.)
    fireEvent.change(screen.getByTestId('agents-search'), { target: { value: 'zzz' } });

    const noResults = await screen.findByTestId('agents-no-results');
    // The bug: the bar unmounted and the first-run empty state rendered. Guard both.
    expect(screen.getByTestId('agents-search')).toBeInTheDocument();
    expect(screen.queryByTestId('agents-empty-state')).not.toBeInTheDocument();
    // the query is echoed in the copy (pins the query={search} wiring).
    expect(noResults).toHaveTextContent('zzz');
  });

  it('keeps the search bar mounted while the search fetch is in flight (guards the isLoading gate removal)', async () => {
    // First call (mount, empty query) returns an agent; the search call is deferred so we can
    // assert mid-flight. The old gate included `!isLoading`, which unmounted the bar during
    // every fetch - this pins its removal.
    let resolveSearch: (value: { data: { id: string; name: string }[] }) => void = () => {};
    getAgentsFromServer.mockResolvedValueOnce({ data: [{ id: 'a1', name: 'Alpha' }] });
    getAgentsFromServer.mockImplementationOnce(() => new Promise(resolve => (resolveSearch = resolve)));

    renderWithTheme(<AgentsPage />);
    await screen.findByTestId('agents-grid');

    fireEvent.change(screen.getByTestId('agents-search'), { target: { value: 'zzz' } });
    // Fetch is still pending (isLoading true) - the bar must remain mounted.
    expect(screen.getByTestId('agents-search')).toBeInTheDocument();

    resolveSearch({ data: [] });
    await screen.findByTestId('agents-no-results');
    expect(screen.getByTestId('agents-search')).toBeInTheDocument();
  });

  it('keeps the search bar mounted when clearing a no-result search (guards the clear flicker)', async () => {
    // Default mock: empty query -> one agent, any query -> none. So mount + clear both load the
    // agent; only the query returns nothing. Reproduces type-no-match -> clear.
    renderWithTheme(<AgentsPage />);
    await screen.findByTestId('agents-grid');

    fireEvent.change(screen.getByTestId('agents-search'), { target: { value: 'zzz' } });
    await screen.findByTestId('agents-no-results');

    // Clearing sets search='' while agents is still the stale [] from the no-match query and the
    // refetch hasn't landed. Without the hasEverHadAgents latch the bar unmounts here (flicker).
    fireEvent.change(screen.getByTestId('agents-search'), { target: { value: '' } });
    expect(screen.getByTestId('agents-search')).toBeInTheDocument();

    await screen.findByTestId('agents-grid');
    expect(screen.getByTestId('agents-search')).toBeInTheDocument();
  });
});
