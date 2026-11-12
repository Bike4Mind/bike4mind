import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IUser } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

type SlackSettings = NonNullable<IUser['slackSettings']>;
type TestUser = { id: string; slackSettings: SlackSettings };
const mocks = vi.hoisted(() => ({ patch: vi.fn(), get: vi.fn(), warning: vi.fn(), success: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { patch: mocks.patch, get: mocks.get } }));
vi.mock('sonner', () => ({ toast: { warning: mocks.warning, success: mocks.success, error: vi.fn() } }));
vi.mock('@client/app/hooks/data/projects', () => ({ useGetJoinedProjects: () => ({ data: [] }) }));
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
