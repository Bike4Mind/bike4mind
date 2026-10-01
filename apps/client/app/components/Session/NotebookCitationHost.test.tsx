import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { CitableSource } from '@bike4mind/common';
import { getThemeConfig } from '../../utils/themes';
import CitableSources from './CitableSources';
import NotebookCitationHost from './NotebookCitationHost';
import useSessionLayout from '@client/app/hooks/useSessionLayout';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

const getFabFileByIdFromServer = vi.fn();
vi.mock('@client/app/utils/filesAPICalls', () => ({
  getFabFileByIdFromServer: (...args: unknown[]) => getFabFileByIdFromServer(...args),
}));

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

const appTheme = extendTheme({ ...getThemeConfig() });

const lakeChip = (id: string, title: string): CitableSource => ({
  id,
  type: 'document',
  title,
  url: `/opti?mode=datalake&article=${id}`,
  status: 'complete',
  metadata: { sourceSystem: 'knowledge_base', chunkId: `chunk-${id}`, fullContext: `Passage of ${id}.` },
});

const renderInHost = (citables: CitableSource[]) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <NotebookCitationHost>
        <CitableSources citables={citables} />
      </NotebookCitationHost>
    </CssVarsProvider>
  );

describe('NotebookCitationHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionLayout.setState({ layout: 'hide', previewFile: null, citedPassage: null, selectedArtifactId: undefined });
  });

  it('opens the cited file beside the chat without navigating', async () => {
    getFabFileByIdFromServer.mockResolvedValue({ id: 'file-1', fileName: 'Leave policy.md' });
    renderInHost([lakeChip('file-1', 'Leave policy.md')]);

    fireEvent.click(screen.getByTestId('citable-source-chip'));

    await waitFor(() => expect(useSessionLayout.getState().previewFile).toMatchObject({ id: 'file-1' }));
    expect(getFabFileByIdFromServer).toHaveBeenCalledWith('file-1');
    expect(useSessionLayout.getState().layout).toBe('vertical');
    expect(useSessionLayout.getState().selectedArtifactId).toBe('file-1');
    expect(useSessionLayout.getState().citedPassage).toEqual({
      fileId: 'file-1',
      chunkId: 'chunk-file-1',
      passage: 'Passage of file-1.',
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps the layout untouched and reports the failure when the file cannot be fetched', async () => {
    getFabFileByIdFromServer.mockRejectedValue(new Error('403'));
    renderInHost([lakeChip('file-1', 'Leave policy.md')]);

    fireEvent.click(screen.getByTestId('citable-source-chip'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not open "Leave policy.md"'));
    expect(useSessionLayout.getState().layout).toBe('hide');
    expect(useSessionLayout.getState().previewFile).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens only the latest click when an earlier fetch resolves late', async () => {
    let resolveFirst: (file: { id: string }) => void = () => undefined;
    getFabFileByIdFromServer.mockImplementation((id: string) =>
      id === 'file-1' ? new Promise(resolve => (resolveFirst = resolve)) : Promise.resolve({ id })
    );
    renderInHost([lakeChip('file-1', 'First.md'), lakeChip('file-2', 'Second.md')]);

    const [first, second] = screen.getAllByTestId('citable-source-chip');
    fireEvent.click(first);
    fireEvent.click(second);
    await waitFor(() => expect(useSessionLayout.getState().previewFile).toMatchObject({ id: 'file-2' }));

    resolveFirst({ id: 'file-1' });
    await Promise.resolve();

    expect(useSessionLayout.getState().previewFile).toMatchObject({ id: 'file-2' });
  });
});
