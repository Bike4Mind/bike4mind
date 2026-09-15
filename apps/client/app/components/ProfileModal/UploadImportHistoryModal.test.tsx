import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import UploadImportHistoryModal from './UploadImportHistoryModal';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('UploadImportHistoryModal', () => {
  it('uploads only once when the Upload button is double-clicked rapidly', async () => {
    let resolveUpload: () => void = () => {};
    const onUpload = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveUpload = resolve;
        })
    );

    render(
      <TestWrapper>
        <UploadImportHistoryModal open onClose={vi.fn()} onUpload={onUpload} onUrlGiven={vi.fn()} />
      </TestWrapper>
    );

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['history'], 'export.zip', { type: 'application/zip' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    const submitButton = screen.getByRole('button', { name: 'Upload LLM History' });
    submitButton.click();
    submitButton.click();

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));

    resolveUpload();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload LLM History' })).not.toBeDisabled());
    expect(onUpload).toHaveBeenCalledTimes(1);
  });
});
