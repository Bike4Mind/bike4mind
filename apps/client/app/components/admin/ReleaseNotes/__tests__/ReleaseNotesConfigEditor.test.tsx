import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { mockGet, mockPut } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPut: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mockGet, put: mockPut } }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import ReleaseNotesConfigEditor from '../ReleaseNotesConfigEditor';

const appTheme = extendTheme({ ...getThemeConfig() });
const stored = { enabled: false, modelId: 'gpt-4o-mini', embargoHours: 12, denylist: ['acme'], slackChannelId: 'C1' };

const renderEditor = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <ReleaseNotesConfigEditor />
      </CssVarsProvider>
    </QueryClientProvider>
  );

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
    fireEvent.click(screen.getByTestId('release-notes-config-save-btn'));

    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith('/api/admin/release-notes/config', {
        ...stored,
        enabled: true,
        denylist: ['acme', 'globex'],
      })
    );
  });

  it('warns when the stored value is malformed', async () => {
    mockGet.mockResolvedValue({ data: { config: { ...stored, denylist: [] }, malformed: true } });
    renderEditor();
    expect(await screen.findByTestId('release-notes-config-malformed')).toBeTruthy();
  });
});
