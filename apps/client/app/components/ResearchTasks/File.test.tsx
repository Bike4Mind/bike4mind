import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IResearchDataWithFiles } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import ResearchTaskFile from './File';

const { addToNotebookContext, sessionState } = vi.hoisted(() => ({
  addToNotebookContext: vi.fn(),
  sessionState: { currentSessionId: 'sess-1' as string | null },
}));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: sessionState.currentSessionId }),
}));
vi.mock('@client/app/hooks/useNotebookContextFiles', () => ({
  useNotebookContextFiles: () => ({ addToNotebookContext, isPending: () => false }),
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
    sessionState.currentSessionId = 'sess-1';
    addToNotebookContext.mockResolvedValue(true);
  });

  it('attaches through the persisting notebook writer, not a bare workbench write', async () => {
    renderFile();
    fireEvent.click(screen.getByTestId('research-file-attach-btn'));
    await waitFor(() =>
      expect(addToNotebookContext).toHaveBeenCalledWith('sess-1', expect.objectContaining({ id: 'file-1' }))
    );
  });

  it('contains a failed persist (the writer has already rolled back and toasted)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    addToNotebookContext.mockRejectedValueOnce(new Error('PUT failed'));
    renderFile();
    fireEvent.click(screen.getByTestId('research-file-attach-btn'));
    await waitFor(() => expect(errSpy).toHaveBeenCalledWith('Failed to attach research file', expect.any(Error)));
    errSpy.mockRestore();
  });

  it('does nothing without a notebook to attach to', () => {
    sessionState.currentSessionId = null;
    renderFile();
    fireEvent.click(screen.getByTestId('research-file-attach-btn'));
    expect(addToNotebookContext).not.toHaveBeenCalled();
  });
});
