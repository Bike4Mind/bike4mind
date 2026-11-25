import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAppFileDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const patch = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { patch: (...args: unknown[]) => patch(...args) } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import EditTagModal, { useEditAppFileTagModal } from './EditTagModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const file = { id: 'f1', tags: ['Reports'], description: 'Old' } as unknown as IAppFileDocument;

const renderModal = () => {
  useEditAppFileTagModal.setState({ targetFile: file });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CssVarsProvider theme={appTheme}>
        <EditTagModal />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

describe('EditTagModal', () => {
  beforeEach(() => {
    patch.mockReset();
    useEditAppFileTagModal.setState({ targetFile: null });
  });

  it('ignores a backdrop click but closes on Escape', () => {
    renderModal();
    expect(screen.getByRole('dialog', { name: 'Report settings' })).toBeTruthy();
    // Joy's backdrop has no slot for a test id; MuiModal-backdrop is its stable utility class.
    fireEvent.click(document.querySelector('.MuiModal-backdrop') as Element);
    expect(useEditAppFileTagModal.getState().targetFile).toBe(file);
    fireEvent.keyDown(screen.getByTestId('edit-tag-modal'), { key: 'Escape' });
    expect(useEditAppFileTagModal.getState().targetFile).toBeNull();
  });

  it('saves the tags through the update-tags endpoint and closes', async () => {
    patch.mockResolvedValue({ data: file });
    renderModal();
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-tag-save-btn'));
    });
    expect(patch).toHaveBeenCalledWith('/api/app-files/update-tags', expect.objectContaining({ id: 'f1' }));
    expect(useEditAppFileTagModal.getState().targetFile).toBeNull();
  });

  it('keeps the dialog open on Escape while a save is in flight', async () => {
    patch.mockReturnValue(new Promise(() => {}));
    renderModal();
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-tag-save-btn'));
    });
    await waitFor(() => expect(screen.getByTestId('edit-tag-modal-close-btn')).toBeDisabled());
    fireEvent.keyDown(screen.getByTestId('edit-tag-modal'), { key: 'Escape' });
    expect(useEditAppFileTagModal.getState().targetFile).toBe(file);
  });
});
