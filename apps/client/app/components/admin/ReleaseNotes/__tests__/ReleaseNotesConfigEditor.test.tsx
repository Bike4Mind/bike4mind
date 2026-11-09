import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { mockGet, mockPut } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPut: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mockGet, put: mockPut } }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useRouter: () => ({
    state: { location: { pathname: '/admin', search: { tab: 'release-notes' } } },
    navigate: vi.fn(),
  }),
}));

import { SettingsDraftProvider } from '../../SettingsDraftProvider';
import ReleaseNotesConfigEditor from '../ReleaseNotesConfigEditor';

const appTheme = extendTheme({ ...getThemeConfig() });
const stored = { enabled: false, modelId: 'gpt-4o-mini', embargoHours: 12, denylist: ['acme'], slackChannelId: 'C1' };

const renderEditor = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <SettingsDraftProvider>
          <ReleaseNotesConfigEditor />
        </SettingsDraftProvider>
      </CssVarsProvider>
    </QueryClientProvider>
  );

const saveBar = () => screen.queryByTestId('admin-save-bar');

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue({ data: { config: stored, malformed: false } });
  mockPut.mockImplementation(async (_url: string, body: unknown) => ({ data: { config: body, malformed: false } }));
});

describe('ReleaseNotesConfigEditor', () => {
  it('sends the full config object, including fields the admin did not touch', async () => {
    renderEditor();
    fireEvent.click(await screen.findByTestId('release-notes-config-enabled'));
    const denyInput = screen.getByTestId('release-notes-config-denylist-input');
    fireEvent.change(denyInput, { target: { value: 'globex' } });
    fireEvent.keyDown(denyInput, { key: 'Enter' });

    // One draft for the whole object: it is saved by one PUT.
    expect(saveBar()).toHaveTextContent('1 unsaved change');
    expect(mockPut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/api/admin/release-notes/config', {
        ...stored,
        enabled: true,
        denylist: ['acme', 'globex'],
      })
    );
    await waitFor(() => expect(saveBar()).toBeNull());
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('release-notes-config-enabled')).toBeChecked();
  });

  it('saves through the page SaveBar, with no Save button of its own', async () => {
    renderEditor();
    const section = await screen.findByTestId('release-notes-config-section');
    await screen.findByTestId('release-notes-config');

    expect(section.tagName).toBe('SECTION');
    expect(within(section).getByRole('heading', { level: 2 }).textContent).toBe('Settings');
    expect(screen.queryByTestId('release-notes-config-save-btn')).toBeNull();
    expect(within(section).queryByRole('button', { name: /save/i })).toBeNull();
    expect(saveBar()).toBeNull();
  });

  it('discards a staged edit back to the stored settings without a request', async () => {
    renderEditor();
    fireEvent.change(await screen.findByTestId('release-notes-config-model-id'), { target: { value: 'other-model' } });
    expect(saveBar()).toHaveTextContent('1 unsaved change');

    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    expect(screen.getByTestId('release-notes-config-model-id')).toHaveValue('gpt-4o-mini');
    expect(saveBar()).toBeNull();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('gives every text field the same width', async () => {
    renderEditor();
    await screen.findByTestId('release-notes-config');

    for (const id of [
      'release-notes-config-model-id',
      'release-notes-config-embargo',
      'release-notes-config-slack-team-id',
      'release-notes-config-slack-channel-id',
      'release-notes-config-denylist-input',
    ]) {
      expect(screen.getByTestId(id).closest('.MuiFormControl-root'), id).toHaveStyle({ maxWidth: '40rem' });
    }
  });

  it('warns when the stored value is malformed, and lets Save replace it with the shown defaults', async () => {
    mockGet.mockResolvedValue({ data: { config: { ...stored, denylist: [] }, malformed: true } });
    renderEditor();
    expect(await screen.findByTestId('release-notes-config-malformed')).toBeTruthy();
    expect(saveBar()).toBeNull();

    fireEvent.click(screen.getByTestId('release-notes-config-use-defaults-btn'));
    expect(saveBar()).toHaveTextContent('1 unsaved change');
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/api/admin/release-notes/config', { ...stored, denylist: [] })
    );
  });

  it('shows the toolkit loading state, then the toolkit error state with a retry', async () => {
    let fail = true;
    mockGet.mockImplementation(async () => {
      if (fail) throw new Error('Service unavailable');
      return { data: { config: stored, malformed: false } };
    });
    renderEditor();

    expect(screen.getByTestId('release-notes-config-loading')).toBeTruthy();
    const error = await screen.findByTestId('admin-error-state');
    expect(error.textContent).toContain('Service unavailable');

    fail = false;
    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('release-notes-config')).toBeTruthy();
  });
});
