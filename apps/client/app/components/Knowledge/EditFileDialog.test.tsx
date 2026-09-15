import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';
import EditFileDialog from './EditFileDialog';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// Only fileName is read by the dialog; the rest of IFabFileDocument is irrelevant here.
const testFile = { fileName: 'notes.md' } as unknown as IFabFileDocument;

describe('EditFileDialog', () => {
  it('submits only once when the submit button is double-clicked rapidly', async () => {
    let resolveSubmit: () => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveSubmit = resolve;
        })
    );

    render(
      <TestWrapper>
        <EditFileDialog open file={testFile} onClose={vi.fn()} onSubmit={onSubmit} />
      </TestWrapper>
    );

    const user = userEvent.setup({ delay: null });
    await user.type(screen.getByTestId('edit-file-dialog-instruction-input'), 'Fix grammar');

    const submitButton = screen.getByTestId('edit-file-dialog-submit-btn');
    submitButton.click();
    submitButton.click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    resolveSubmit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });
});
