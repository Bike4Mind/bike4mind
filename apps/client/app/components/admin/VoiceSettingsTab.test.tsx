import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
  apiPatch: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.apiGet, delete: mocks.apiDelete, patch: mocks.apiPatch, post: vi.fn() },
}));
vi.mock('@client/app/hooks/data/elevenLabsVoices', () => ({
  useElevenLabsVoices: () => ({ data: [], isLoading: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import VoiceSettingsTab from './VoiceSettingsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const agent = {
  id: 'agent-1',
  name: 'Concierge',
  description: 'Greets callers',
  elevenLabsAgentId: 'el-123',
  isDefaultVoiceAgent: true,
};

let agentsResponse: (typeof agent)[] | Error | 'pending';

const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <VoiceSettingsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );

beforeEach(() => {
  agentsResponse = [agent];
  mocks.apiGet.mockReset().mockImplementation(async () => {
    if (agentsResponse === 'pending') return new Promise(() => undefined);
    if (agentsResponse instanceof Error) throw agentsResponse;
    return { data: { agents: agentsResponse } };
  });
  mocks.apiDelete.mockReset().mockResolvedValue({});
  mocks.apiPatch.mockReset().mockResolvedValue({});
});

describe('VoiceSettingsTab', () => {
  it('opens with the page header, its count and the create action', async () => {
    renderTab();

    const tab = screen.getByTestId('admin-voice-settings-tab');
    const header = screen.getByTestId('admin-page-header');
    expect(tab.firstElementChild).toBe(header);
    await waitFor(() => expect(within(header).getByRole('heading', { level: 1 }).textContent).toBe('Voice (1)'));
    expect(within(header).getByTestId('voice-settings-create-btn')).toBeTruthy();
  });

  it('shows a labelled loading state on first load', () => {
    agentsResponse = 'pending';
    renderTab();

    expect(screen.getByTestId('admin-loading-state').textContent).toContain('Loading voice agents');
  });

  it('shows the empty state with the create action in place of the list', async () => {
    agentsResponse = [];
    renderTab();

    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty.textContent).toContain('No voice agents yet');
    expect(within(empty).getByTestId('voice-settings-create-btn')).toBeTruthy();
    expect(screen.getAllByTestId('voice-settings-create-btn')).toHaveLength(1);
  });

  it('shows an error with a retry when the list fails to load', async () => {
    agentsResponse = new Error('boom');
    renderTab();

    expect((await screen.findByTestId('admin-error-state')).textContent).toContain('could not be loaded');
    agentsResponse = [agent];
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('voice-settings-row-agent-1')).toBeTruthy();
  });

  it('lists agents in one table with the agent ID and default switch', async () => {
    renderTab();

    const row = await screen.findByTestId('voice-settings-row-agent-1');
    expect(row.textContent).toContain('Concierge');
    expect(row.textContent).toContain('el-123');
    expect(within(screen.getByTestId('voice-settings-default-agent-1')).getByRole('switch')).toBeChecked();
    expect(screen.getByTestId('voice-settings-list').querySelector('.MuiCard-root')).toBeNull();
  });

  it('puts download, edit and delete in one row menu', async () => {
    renderTab();

    const row = await screen.findByTestId('voice-settings-row-agent-1');
    const trigger = within(row).getByTestId('voice-settings-row-actions-agent-1');
    expect(trigger).toHaveAccessibleName('Actions for Concierge');

    fireEvent.click(trigger);
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Download ElevenLabs config',
      'Edit voice agent',
      'Delete voice agent',
    ]);

    fireEvent.click(screen.getByTestId('voice-settings-edit-agent-1'));
    expect(screen.getByTestId('voice-settings-editor-modal')).toBeTruthy();
  });

  it('confirms a delete in a dialog that names the consequence', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderTab();

    const row = await screen.findByTestId('voice-settings-row-agent-1');
    fireEvent.click(within(row).getByTestId('voice-settings-row-actions-agent-1'));
    fireEvent.click(screen.getByTestId('voice-settings-delete-agent-1'));
    // Picking from the menu must not also activate the row, which opens the editor.
    expect(screen.queryByTestId('voice-settings-editor-modal')).toBeNull();
    const dialog = screen.getByTestId('voice-settings-delete-dialog');
    expect(dialog.textContent).toContain('removed here and in ElevenLabs');

    fireEvent.click(within(dialog).getByTestId('voice-settings-delete-confirm-btn'));
    await waitFor(() => expect(mocks.apiDelete).toHaveBeenCalledWith('/api/admin/voice-agents/agent-1'));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('opens the editor when a row is clicked', async () => {
    renderTab();

    fireEvent.click(await screen.findByTestId('voice-settings-row-agent-1'));
    const editor = screen.getByTestId('voice-settings-editor-modal');
    expect(within(editor).getByRole('heading', { name: 'Edit voice agent' })).toBeTruthy();
    expect(
      (within(editor).getByTestId('voice-settings-form-name').querySelector('input') as HTMLInputElement).value
    ).toBe('Concierge');
  });

  it('toggles the default switch without opening the editor', async () => {
    renderTab();

    await screen.findByTestId('voice-settings-row-agent-1');
    fireEvent.click(within(screen.getByTestId('voice-settings-default-agent-1')).getByRole('switch'));

    await waitFor(() =>
      expect(mocks.apiPatch).toHaveBeenCalledWith('/api/admin/voice-agents/agent-1', { isDefault: false })
    );
    expect(screen.queryByTestId('voice-settings-editor-modal')).toBeNull();
  });
});
