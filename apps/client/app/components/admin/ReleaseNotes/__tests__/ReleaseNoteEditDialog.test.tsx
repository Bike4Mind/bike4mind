import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { mockPatch } = vi.hoisted(() => ({ mockPatch: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: mockPatch, put: vi.fn() },
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

import ReleaseNoteEditDialog from '../ReleaseNoteEditDialog';
import type { AdminReleaseNote } from '../useReleaseNotes';

const appTheme = extendTheme({ ...getThemeConfig() });

const first = { category: 'new' as const, text: 'Faster search', importance: 1 as const, sourcePrs: [] };
const second = { category: 'fixed' as const, text: 'Login loop', importance: 2 as const, sourcePrs: [] };
const note = {
  id: 'n1',
  releaseTag: 'v1.0.0',
  headline: 'Headline',
  summary: 'Summary',
  items: [first, second],
  state: 'scheduled',
  publishAt: new Date().toISOString(),
  deployedAt: new Date().toISOString(),
  deployedSha: 'abc',
  editedAt: null,
} as unknown as AdminReleaseNote;

beforeEach(() => vi.clearAllMocks());

describe('ReleaseNoteEditDialog', () => {
  it('saves the item list after one item is removed and one is added', async () => {
    mockPatch.mockResolvedValue({ data: note });
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CssVarsProvider theme={appTheme}>
          <ReleaseNoteEditDialog note={note} onClose={onClose} />
        </CssVarsProvider>
      </QueryClientProvider>
    );

    fireEvent.click(screen.getAllByTestId('release-note-edit-remove-item-btn')[0]);
    fireEvent.click(screen.getByTestId('release-note-edit-add-item-btn'));
    const inputs = screen.getAllByTestId('release-note-edit-item-input');
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[1], { target: { value: 'Dark mode' } });
    fireEvent.click(screen.getByTestId('release-note-edit-save-btn'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockPatch).toHaveBeenCalledWith('/api/admin/release-notes/n1', {
      headline: 'Headline',
      summary: 'Summary',
      items: [second, { category: 'new', text: 'Dark mode', importance: 2, sourcePrs: [] }],
    });
  });
});
