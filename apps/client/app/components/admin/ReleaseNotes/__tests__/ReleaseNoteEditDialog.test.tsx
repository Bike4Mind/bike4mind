import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { mockPatch, mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockPatch: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: mockPatch, put: vi.fn() },
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useConfig: () => ({ data: { fabfileBucketName: 'fab-bucket' } }),
}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: mockToastError, success: mockToastSuccess }),
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

  const renderDialog = (value: AdminReleaseNote, onClose = vi.fn()) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CssVarsProvider theme={appTheme}>
          <ReleaseNoteEditDialog note={value} onClose={onClose} />
        </CssVarsProvider>
      </QueryClientProvider>
    );

  it('opens in the admin dialog shell, whose close button and Cancel both close without saving', () => {
    const onClose = vi.fn();
    renderDialog(note, onClose);

    const dialog = screen.getByTestId('release-note-edit-dialog');
    const title = within(dialog).getByRole('heading', { level: 2 });
    expect(title.textContent).toBe('Edit release notes for v1.0.0');
    expect(dialog).toHaveAttribute('aria-labelledby', title.id);

    fireEvent.click(screen.getByTestId('release-note-edit-dialog-close-btn'));
    fireEvent.click(screen.getByTestId('release-note-edit-cancel-btn'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('stays open while the save is in flight: Cancel is disabled and the close button and Esc do nothing', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockPatch.mockImplementation(() => new Promise(resolve => (finish = resolve)));
    const onClose = vi.fn();
    renderDialog(note, onClose);

    fireEvent.click(screen.getByTestId('release-note-edit-save-btn'));
    await waitFor(() => expect(screen.getByTestId('release-note-edit-cancel-btn')).toBeDisabled());
    fireEvent.click(screen.getByTestId('release-note-edit-dialog-close-btn'));
    fireEvent.keyDown(screen.getByTestId('release-note-edit-headline'), { key: 'Escape', code: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    finish({ data: note });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockToastSuccess).toHaveBeenCalledWith('Release note saved');
  });

  it('reports a failed save and stays open so the edit is not lost', async () => {
    mockPatch.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 500'), {
        isAxiosError: true,
        response: { status: 500, data: { error: 'The release note could not be saved' } },
      })
    );
    const onClose = vi.fn();
    renderDialog(note, onClose);

    fireEvent.change(screen.getByTestId('release-note-edit-headline'), { target: { value: 'Edited headline' } });
    fireEvent.click(screen.getByTestId('release-note-edit-save-btn'));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('The release note could not be saved'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('release-note-edit-headline')).toHaveValue('Edited headline');
    await waitFor(() => expect(screen.getByTestId('release-note-edit-cancel-btn')).not.toBeDisabled());
  });

  it('sends the video when one is pasted', async () => {
    mockPatch.mockResolvedValue({ data: note });
    renderDialog(note);

    fireEvent.change(screen.getByTestId('modal-video-landscape-video-input'), {
      target: { value: 'https://d111.cloudfront.net/wide.mp4' },
    });
    fireEvent.click(screen.getByTestId('release-note-edit-save-btn'));

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    expect(mockPatch.mock.calls[0][1]).toMatchObject({
      video: expect.objectContaining({ landscapeUrl: 'https://d111.cloudfront.net/wide.mp4' }),
    });
  });

  it('sends null when the stored video is cleared', async () => {
    mockPatch.mockResolvedValue({ data: note });
    renderDialog({ ...note, video: { landscapeUrl: 'https://d111.cloudfront.net/wide.mp4' } });

    fireEvent.click(screen.getByTestId('modal-video-landscape-video-clear-btn'));
    fireEvent.click(screen.getByTestId('release-note-edit-save-btn'));

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    expect(mockPatch.mock.calls[0][1]).toMatchObject({ video: null });
  });

  it('blocks saving a video on a disallowed host', () => {
    renderDialog(note);

    fireEvent.change(screen.getByTestId('modal-video-landscape-video-input'), {
      target: { value: 'https://evil.example.com/wide.mp4' },
    });

    expect(screen.getByTestId('release-note-edit-save-btn')).toBeDisabled();
  });
  const stillNote = {
    ...note,
    image: { landscapeUrl: 'https://d111.cloudfront.net/s.png', portraitUrl: null },
  } as AdminReleaseNote;

  it('sends null for the image once it is removed', async () => {
    mockPatch.mockResolvedValue({ data: note });
    renderDialog(stillNote);

    expect(screen.getByText('Still image attached (16:9 and 9:16)')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('release-note-edit-remove-image-btn'));
    expect(screen.getByTestId('release-note-edit-image-status')).toHaveTextContent('Still image is removed on save');
    fireEvent.click(screen.getByTestId('release-note-edit-save-btn'));

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    expect(mockPatch).toHaveBeenCalledWith('/api/admin/release-notes/n1', expect.objectContaining({ image: null }));
  });

  it('sends no image key when the still is untouched', async () => {
    mockPatch.mockResolvedValue({ data: note });
    renderDialog(stillNote);

    fireEvent.click(screen.getByTestId('release-note-edit-save-btn'));

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    expect('image' in mockPatch.mock.calls[0][1]).toBe(false);
  });

  it('shows no still row for a note without an image', () => {
    renderDialog({ ...note, image: null } as AdminReleaseNote);

    expect(screen.queryByTestId('release-note-edit-remove-image-btn')).toBeNull();
  });
});
