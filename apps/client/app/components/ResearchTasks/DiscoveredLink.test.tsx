import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredLink } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import ResearchTaskDiscoveredLink from './DiscoveredLink';

const { addToNotebookContext, getFabFileByIdFromServer, activeNotebook, toastInfo, toastError } = vi.hoisted(() => ({
  addToNotebookContext: vi.fn(),
  getFabFileByIdFromServer: vi.fn(),
  activeNotebook: {
    value: { onScreen: true, sessionId: 'sess-1' } as { onScreen: boolean; sessionId?: string | null },
  },
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/hooks/useActiveNotebook', () => ({ useActiveNotebook: () => activeNotebook.value }));
vi.mock('@client/app/hooks/useNotebookContextFiles', () => ({
  useNotebookContextFiles: () => ({ addToNotebookContext }),
}));
vi.mock('@client/app/utils/filesAPICalls', () => ({ getFabFileByIdFromServer }));
vi.mock('sonner', () => ({ toast: { info: toastInfo, error: toastError, success: vi.fn() } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const link = {
  url: 'https://example.com/doc.pdf',
  text: 'Doc',
  researchDataId: 'rd-1',
  relevance: 0.9,
} as unknown as DiscoveredLink;

const renderLink = (getFabFileId: (id: string) => string | undefined = () => 'f1') =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ResearchTaskDiscoveredLink link={link} getFabFileId={getFabFileId} />
    </CssVarsProvider>
  );

const attachButton = () => screen.getByTestId('research-link-attach-btn');
// Joy renders `loading` as a disabled button with a spinner.
const expectSettled = () => waitFor(() => expect(attachButton()).not.toBeDisabled());

describe('ResearchTaskDiscoveredLink attach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeNotebook.value = { onScreen: true, sessionId: 'sess-1' };
    getFabFileByIdFromServer.mockResolvedValue({ id: 'f1', fileName: 'doc.pdf' });
    addToNotebookContext.mockResolvedValue(true);
  });

  it('loads the file and attaches it through the persisting writer', async () => {
    renderLink();
    fireEvent.click(attachButton());
    await waitFor(() =>
      expect(addToNotebookContext).toHaveBeenCalledWith('sess-1', expect.objectContaining({ id: 'f1' }))
    );
    expect(getFabFileByIdFromServer).toHaveBeenCalledWith('f1');
    await expectSettled();
  });

  it('toasts once and does not attach when the file cannot be loaded', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getFabFileByIdFromServer.mockRejectedValueOnce(new Error('404'));
    renderLink();
    fireEvent.click(attachButton());
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith('Could not load that file');
    expect(addToNotebookContext).not.toHaveBeenCalled();
    await expectSettled();
    errSpy.mockRestore();
  });

  it('adds no toast of its own when the persist fails, and clears the spinner', async () => {
    addToNotebookContext.mockRejectedValueOnce(new Error('PUT failed'));
    renderLink();
    fireEvent.click(attachButton());
    await waitFor(() => expect(addToNotebookContext).toHaveBeenCalled());
    await expectSettled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('tells the user to open a notebook, without fetching, when none is on screen', () => {
    activeNotebook.value = { onScreen: false };
    renderLink();
    fireEvent.click(attachButton());
    expect(toastInfo).toHaveBeenCalledWith('Open a notebook to attach this file to it.');
    expect(getFabFileByIdFromServer).not.toHaveBeenCalled();
    expect(addToNotebookContext).not.toHaveBeenCalled();
  });

  it('does nothing when the research data has no resolvable file', () => {
    renderLink(() => undefined);
    fireEvent.click(attachButton());
    expect(getFabFileByIdFromServer).not.toHaveBeenCalled();
    expect(addToNotebookContext).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });
});
