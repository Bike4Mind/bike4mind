import { act } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUser } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

type SlackSettings = NonNullable<IUser['slackSettings']>;
type TestUser = { id: string; slackSettings: SlackSettings };
const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  get: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
  projects: vi.fn(),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { patch: mocks.patch, get: mocks.get } }));
vi.mock('sonner', () => ({ toast: { warning: mocks.warning, success: mocks.success, error: vi.fn() } }));
vi.mock('@client/app/hooks/data/projects', () => ({ useGetJoinedProjects: () => mocks.projects() }));
vi.mock('@client/app/components/help', () => ({ FieldTooltip: () => null, ContextHelpButton: () => null }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@client/app/contexts/UserContext', async () => {
  const { create } = await import('zustand');
  const useUser = create<{
    currentUser: TestUser | null;
    setCurrentUser: (user: TestUser | null) => void;
  }>(set => ({ currentUser: null, setCurrentUser: currentUser => set({ currentUser }) }));
  return { useUser };
});
import { useUser } from '@client/app/contexts/UserContext';
import SlackIntegrationSection from './SlackIntegrationSection';

const settings: SlackSettings = {
  slackUserId: 'U0123456789',
  slackTeamId: 'T0123456789',
  autoCreateNotebook: true,
  notebookNamePrefix: 'Slack Chat',
  keywordRouting: [{ keywords: ['bug'], notebookId: 'deleted-notebook' }],
};
const theme = extendTheme({ ...getThemeConfig() });
const show = (client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>
        <SlackIntegrationSection />
      </CssVarsProvider>
    </QueryClientProvider>
  );
const save = () => screen.getByTestId('slack-settings-save-btn');

beforeEach(() => {
  mocks.patch.mockReset();
  mocks.warning.mockReset();
  mocks.success.mockReset();
  mocks.get.mockReset();
  mocks.projects.mockReset();
  mocks.projects.mockReturnValue({ data: [] });
  mocks.get.mockImplementation(async (url: string) => ({
    data: url.includes('workspaces')
      ? { workspaces: [] }
      : url.includes('agents')
        ? { agents: [] }
        : { data: [], hasMore: false },
  }));
  useUser.setState({
    currentUser: { id: 'user-one', slackSettings: settings } as ReturnType<typeof useUser.getState>['currentUser'],
  });
});

describe('Slack settings saves', () => {
  it('preserves saved routing through a cold option load and a cold remount', async () => {
    const saved: SlackSettings = {
      ...settings,
      keywordRouting: [],
      agentNotebookRouting: { dev: 'saved-notebook' },
      defaultProjectId: 'saved-project',
      customAgentId: 'saved-agent',
    };
    mocks.patch.mockResolvedValue({ data: { slackSettings: saved } });
    for (let attempt = 0; attempt < 2; attempt++) {
      let complete: (value: { data: { data: { id: string; name: string }[]; hasMore: boolean } }) => void = () => {
        throw new Error('Notebook request not started');
      };
      mocks.get.mockImplementation(async (url: string) => {
        if (url === '/api/sessions')
          return new Promise(resolve => {
            complete = resolve;
          });
        return { data: url.includes('agents') ? { agents: [] } : { workspaces: [] } };
      });
      useUser.setState({
        currentUser: { id: 'user-one', slackSettings: saved } as ReturnType<typeof useUser.getState>['currentUser'],
      });
      const view = show();
      await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/sessions', { params: { limit: 100 } }));
      await act(async () => {
        complete({ data: { data: [{ id: 'saved-notebook', name: 'Saved notebook' }], hasMore: false } });
      });
      fireEvent.click(save());
      await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(attempt + 1));
      expect(mocks.patch).toHaveBeenLastCalledWith(
        '/api/users/user-one/slack-settings',
        expect.objectContaining({
          agentNotebookRouting: { dev: 'saved-notebook' },
          defaultProjectId: 'saved-project',
          customAgentId: 'saved-agent',
        })
      );
      await waitFor(() => expect(save()).not.toBeDisabled());
      view.unmount();
    }
  });
  it.each(['missing', 'failed'] as const)(
    'keeps saved references when options are %s until the server validates them',
    async state => {
      const saved: SlackSettings = {
        ...settings,
        keywordRouting: [],
        agentNotebookRouting: { dev: 'saved-notebook' },
        defaultProjectId: 'saved-project',
        customAgentId: 'saved-agent',
      };
      useUser.setState({
        currentUser: { id: 'user-one', slackSettings: saved } as ReturnType<typeof useUser.getState>['currentUser'],
      });
      mocks.get.mockImplementation(async (url: string) => {
        if (url === '/api/sessions' && state === 'failed') throw new Error('offline');
        return {
          data: url.includes('agents')
            ? { agents: [] }
            : url.includes('workspaces')
              ? { workspaces: [] }
              : { data: [], hasMore: true },
        };
      });
      mocks.patch.mockResolvedValue({ data: { slackSettings: saved } });
      show();
      await waitFor(() =>
        expect(screen.getByTestId('slack-agent-notebook-select-dev')).toHaveTextContent('Saved notebook (not loaded)')
      );
      expect(screen.getByTestId('slack-default-project-select')).toHaveTextContent('Saved project (not loaded)');
      expect(screen.getByTestId('slack-custom-agent-select')).toHaveTextContent('Saved agent (not loaded)');
      fireEvent.click(save());
      await waitFor(() => expect(mocks.patch).toHaveBeenCalledOnce());
      expect(mocks.patch).toHaveBeenCalledWith(
        '/api/users/user-one/slack-settings',
        expect.objectContaining({
          agentNotebookRouting: { dev: 'saved-notebook' },
          defaultProjectId: 'saved-project',
          customAgentId: 'saved-agent',
        })
      );
    }
  );

  it('keeps a saved project that is absent from a loaded project list', async () => {
    const saved: SlackSettings = { ...settings, keywordRouting: [], defaultProjectId: 'saved-project' };
    useUser.setState({
      currentUser: { id: 'user-one', slackSettings: saved } as ReturnType<typeof useUser.getState>['currentUser'],
    });
    mocks.projects.mockReturnValue({ data: [{ id: 'other-project', name: 'Other project' }] });
    mocks.patch.mockResolvedValue({ data: { slackSettings: saved } });
    show();
    await waitFor(() =>
      expect(screen.getByTestId('slack-default-project-select')).toHaveTextContent('Saved project (not loaded)')
    );
    fireEvent.click(save());
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledOnce());
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/users/user-one/slack-settings',
      expect.objectContaining({ defaultProjectId: 'saved-project' })
    );
  });

  it('still lets the user deliberately clear a saved routing choice', async () => {
    const saved: SlackSettings = { ...settings, keywordRouting: [], agentNotebookRouting: { dev: 'saved-notebook' } };
    useUser.setState({
      currentUser: { id: 'user-one', slackSettings: saved } as ReturnType<typeof useUser.getState>['currentUser'],
    });
    mocks.patch.mockResolvedValue({ data: { slackSettings: { ...saved, agentNotebookRouting: {} } } });
    show();
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId('slack-agent-notebook-select-dev')).getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Use default routing' }));
    await user.click(save());
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledOnce());
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/users/user-one/slack-settings',
      expect.objectContaining({ agentNotebookRouting: {} })
    );
  });

  it('does not reuse a previous account notebook list while the next account loads', async () => {
    const first: SlackSettings = { ...settings, keywordRouting: [], agentNotebookRouting: { dev: 'first-notebook' } };
    useUser.setState({
      currentUser: { id: 'user-one', slackSettings: first } as ReturnType<typeof useUser.getState>['currentUser'],
    });
    mocks.get.mockImplementation(async (url: string) => ({
      data:
        url === '/api/sessions'
          ? { data: [{ id: 'first-notebook', name: 'First account notebook' }], hasMore: false }
          : url.includes('agents')
            ? { agents: [] }
            : { workspaces: [] },
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    show(client);
    await waitFor(() =>
      expect(screen.getByTestId('slack-agent-notebook-select-dev')).toHaveTextContent('First account notebook')
    );
    let complete: (value: { data: { data: { id: string; name: string }[]; hasMore: boolean } }) => void = () => {
      throw new Error('Second account request not started');
    };
    mocks.get.mockImplementation(async (url: string) => {
      if (url === '/api/sessions')
        return new Promise(resolve => {
          complete = resolve;
        });
      return { data: url.includes('agents') ? { agents: [] } : { workspaces: [] } };
    });
    act(() =>
      useUser.setState({
        currentUser: {
          id: 'user-two',
          slackSettings: { ...settings, keywordRouting: [], agentNotebookRouting: { dev: 'second-notebook' } },
        } as ReturnType<typeof useUser.getState>['currentUser'],
      })
    );
    await waitFor(() => expect(mocks.get.mock.calls.filter(([url]) => url === '/api/sessions')).toHaveLength(2));
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId('slack-agent-notebook-select-dev')).getByRole('combobox'));
    expect(screen.queryByRole('option', { name: 'First account notebook' })).not.toBeInTheDocument();
    await act(async () => {
      complete({ data: { data: [{ id: 'second-notebook', name: 'Second account notebook' }], hasMore: false } });
    });
    await waitFor(() =>
      expect(screen.getByTestId('slack-agent-notebook-select-dev')).toHaveTextContent('Second account notebook')
    );
  });

  it('keeps an existing keyword rule notebook while its option is outside the loaded page', async () => {
    const saved: SlackSettings = { ...settings, keywordRouting: [{ keywords: ['bug'], notebookId: 'saved-notebook' }] };
    useUser.setState({
      currentUser: { id: 'user-one', slackSettings: saved } as ReturnType<typeof useUser.getState>['currentUser'],
    });
    mocks.patch.mockResolvedValue({ data: { slackSettings: saved } });
    show();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit routing rule 1' }));
    expect(screen.getByTestId('slack-rule-notebook-select')).toHaveTextContent('Saved notebook (not loaded)');
    fireEvent.change(screen.getByRole('textbox', { name: 'Keywords (comma-separated)' }), {
      target: { value: 'bug, urgent' },
    });
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await user.click(save());
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledOnce());
    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/users/user-one/slack-settings',
      expect.objectContaining({ keywordRouting: [{ keywords: ['bug', 'urgent'], notebookId: 'saved-notebook' }] })
    );
  });

  it('removes sanitized rules from the form, next save and reopened form', async () => {
    const sanitized = { ...settings, keywordRouting: [] };
    mocks.patch.mockResolvedValue({
      data: { slackSettings: sanitized, removed: [{ field: 'keywordRouting', id: 'deleted-notebook' }] },
    });
    const view = show();
    expect(screen.getByText('deleted-notebook')).toBeInTheDocument();
    fireEvent.click(save());
    await waitFor(() => expect(screen.queryByText('deleted-notebook')).not.toBeInTheDocument());
    expect(useUser.getState().currentUser?.slackSettings).toEqual(sanitized);
    expect(mocks.warning).toHaveBeenCalledOnce();
    fireEvent.click(save());
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    expect(mocks.patch.mock.calls[1][1].keywordRouting).toBeUndefined();
    view.unmount();
    show();
    expect(screen.queryByText('deleted-notebook')).not.toBeInTheDocument();
  });

  it('locks edits until a delayed save completes, then permits the next draft', async () => {
    let complete: (value: { data: { slackSettings: SlackSettings } }) => void = () => {
      throw new Error('Save not started');
    };
    mocks.patch.mockImplementation(
      () =>
        new Promise(resolve => {
          complete = resolve;
        })
    );
    show();
    fireEvent.click(save());
    await waitFor(() => expect(save()).toBeDisabled());
    const prefix = screen.getByTestId('slack-settings-prefix-input');
    expect(prefix).toBeDisabled();
    expect(screen.getByTestId('slack-settings-auto-create-btn')).toBeDisabled();
    expect(screen.getByTestId('slack-settings-add-rule-btn')).toBeDisabled();
    await act(async () => {
      complete({ data: { slackSettings: settings } });
    });
    await waitFor(() => expect(prefix).not.toBeDisabled());
    fireEvent.change(prefix, { target: { value: 'Next draft' } });
    expect(prefix).toHaveValue('Next draft');
  });

  it('does not write a previous account response into the current account', async () => {
    let complete: (value: { data: { slackSettings: SlackSettings } }) => void = () => {
      throw new Error('Save not started');
    };
    mocks.patch.mockImplementation(
      () =>
        new Promise(resolve => {
          complete = resolve;
        })
    );
    show();
    fireEvent.click(save());
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledOnce());
    const otherSettings = { ...settings, notebookNamePrefix: 'Other account' };
    act(() => {
      useUser.setState({
        currentUser: { id: 'user-two', slackSettings: otherSettings } as ReturnType<
          typeof useUser.getState
        >['currentUser'],
      });
    });
    await act(async () => {
      complete({ data: { slackSettings: settings } });
    });
    await waitFor(() => expect(save()).not.toBeDisabled());
    expect(useUser.getState().currentUser?.slackSettings).toEqual(otherSettings);
    expect(mocks.success).not.toHaveBeenCalled();
  });
});
