import { act } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  projects: [] as Array<{ id: string; name: string }>,
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { patch: mocks.patch, get: mocks.get } }));
vi.mock('sonner', () => ({ toast: { warning: mocks.warning, success: mocks.success, error: vi.fn() } }));
vi.mock('@client/app/hooks/data/projects', () => ({ useGetJoinedProjects: () => ({ data: mocks.projects }) }));
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
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
  mocks.projects = [];
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

describe('Slack settings selects with lists that load after mount', () => {
  const routed: SlackSettings = {
    ...settings,
    keywordRouting: [],
    agentNotebookRouting: { dev: 'notebook-b', pm: 'notebook-c' },
  };
  const notebookList = {
    data: [
      { id: 'notebook-b', name: 'Notebook B' },
      { id: 'notebook-c', name: 'Notebook C' },
    ],
    hasMore: false,
  };
  const asUser = (slackSettings?: SlackSettings) =>
    ({ id: 'user-one', slackSettings }) as ReturnType<typeof useUser.getState>['currentUser'];
  const routingSelect = (agent: string) =>
    within(screen.getByTestId(`slack-settings-agent-routing-${agent}-select`)).getByRole('combobox');
  const savedPayload = async () => {
    fireEvent.click(save());
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledOnce());
    return mocks.patch.mock.calls[0][1] as SlackSettings;
  };

  // Holds GET /api/sessions until the returned release is called, as on a cold drawer open.
  const holdNotebooks = (agents: Array<{ id: string; name: string }> = []) => {
    let release: () => void = () => {
      throw new Error('Notebook list not requested');
    };
    mocks.get.mockImplementation((url: string) => {
      if (url === '/api/sessions') {
        return new Promise(resolve => {
          release = () => resolve({ data: notebookList });
        });
      }
      return Promise.resolve({ data: url.includes('workspaces') ? { workspaces: [] } : { agents } });
    });
    return async () => {
      await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('/api/sessions', expect.anything()));
      await act(async () => release());
    };
  };

  beforeEach(() => {
    mocks.patch.mockResolvedValue({ data: {} });
  });

  it('keeps stored agent routing when the section mounts before the notebook list loads', async () => {
    useUser.setState({ currentUser: asUser(routed) });
    const release = holdNotebooks();
    show();
    await release();
    await waitFor(() => expect(routingSelect('dev')).toHaveTextContent('Notebook B'));
    expect(routingSelect('pm')).toHaveTextContent('Notebook C');
    expect((await savedPayload()).agentNotebookRouting).toEqual({ dev: 'notebook-b', pm: 'notebook-c' });
  });

  it('shows routing that arrives after mount, as on Profile after a reload', async () => {
    useUser.setState({ currentUser: asUser() });
    const release = holdNotebooks();
    show();
    act(() => {
      useUser.setState({ currentUser: asUser(routed) });
    });
    await release();
    await waitFor(() => expect(routingSelect('dev')).toHaveTextContent('Notebook B'));
    expect((await savedPayload()).agentNotebookRouting).toEqual({ dev: 'notebook-b', pm: 'notebook-c' });
  });

  it('still applies a routing the user changes or clears', async () => {
    useUser.setState({ currentUser: asUser(routed) });
    const release = holdNotebooks();
    show();
    await release();
    await waitFor(() => expect(routingSelect('dev')).toHaveTextContent('Notebook B'));
    fireEvent.click(routingSelect('dev'));
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Use default routing' }));
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    fireEvent.click(routingSelect('pm'));
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Notebook B' }));
    await waitFor(() => expect(routingSelect('pm')).toHaveTextContent('Notebook B'));
    expect((await savedPayload()).agentNotebookRouting).toEqual({ pm: 'notebook-b' });
  });

  it('keeps the stored custom agent and default project when their lists have not loaded', async () => {
    useUser.setState({
      currentUser: asUser({ ...routed, customAgentId: 'agent-one', defaultProjectId: 'project-one' }),
    });
    const release = holdNotebooks([{ id: 'agent-one', name: 'Agent one' }]);
    show();
    await release();
    await waitFor(() =>
      expect(within(screen.getByTestId('slack-custom-agent-select')).getByRole('combobox')).toHaveTextContent(
        'Agent one'
      )
    );
    const payload = await savedPayload();
    expect(payload.customAgentId).toBe('agent-one');
    expect(payload.defaultProjectId).toBe('project-one');
  });
});
