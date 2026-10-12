import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IResearchDataWithFiles } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import ResearchTaskFile from './File';

const { addToNotebookContext, activeNotebook, toastInfo, pendingIds } = vi.hoisted(() => ({
  addToNotebookContext: vi.fn(),
  activeNotebook: {
    value: { onScreen: true, sessionId: 'sess-1' } as { onScreen: boolean; sessionId?: string | null },
  },
  toastInfo: vi.fn(),
  pendingIds: new Set<string>(),
}));

vi.mock('@client/app/hooks/useActiveNotebook', () => ({ useActiveNotebook: () => activeNotebook.value }));
vi.mock('sonner', () => ({ toast: { info: toastInfo, error: vi.fn(), success: vi.fn() } }));
vi.mock('@client/app/hooks/useNotebookContextFiles', () => ({
  useNotebookContextFiles: () => ({ addToNotebookContext, isPending: (id: string) => pendingIds.has(id) }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: 'user-1' } }) }));
vi.mock('@client/app/hooks/data/fabFiles', () => ({ useChunkFile: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('@client/app/hooks/data/researchData', () => ({
  useDeleteResearchData: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => vi.fn() }));

const appTheme = extendTheme({ ...getThemeConfig() });
const fabFile = { id: 'file-1', fileName: 'findings.md', userId: 'user-1', fileSize: 2048 };
const researchData = { fabFile } as unknown as IResearchDataWithFiles;

const renderFile = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ResearchTaskFile researchData={researchData} onView={vi.fn()} />
    </CssVarsProvider>
  );

describe('ResearchTaskFile attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingIds.clear();
    activeNotebook.value = { onScreen: true, sessionId: 'sess-1' };
    addToNotebookContext.mockResolvedValue(true);
  });

  it('attaches through the persisting notebook writer, not a bare workbench write', async () => {
    renderFile();
    fireEvent.click(screen.getByTestId('research-file-attach-btn'));
    await waitFor(() =>
      expect(addToNotebookContext).toHaveBeenCalledWith('sess-1', expect.objectContaining({ id: 'file-1' }))
    );
  });

  it('attaches with a null session id on /new', async () => {
    activeNotebook.value = { onScreen: true, sessionId: null };
    renderFile();
    fireEvent.click(screen.getByTestId('research-file-attach-btn'));
    await waitFor(() =>
      expect(addToNotebookContext).toHaveBeenCalledWith(null, expect.objectContaining({ id: 'file-1' }))
    );
  });

  it('tells the user to open a notebook when none is on screen', () => {
    activeNotebook.value = { onScreen: false };
    renderFile();
    fireEvent.click(screen.getByTestId('research-file-attach-btn'));
    expect(addToNotebookContext).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith('Open a notebook to attach this file to it.');
  });

  it('contains a failed persist (the writer has already rolled back and toasted)', async () => {
    addToNotebookContext.mockRejectedValueOnce(new Error('PUT failed'));
    renderFile();
    fireEvent.click(screen.getByTestId('research-file-attach-btn'));
    await waitFor(() => expect(addToNotebookContext).toHaveBeenCalled());
    // Flush the rejected promise's microtasks; an uncontained rejection fails the run.
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('disables attach while this file is being persisted', () => {
    pendingIds.add('file-1');
    renderFile();
    expect(screen.getByTestId('research-file-attach-btn')).toBeDisabled();
  });
});
