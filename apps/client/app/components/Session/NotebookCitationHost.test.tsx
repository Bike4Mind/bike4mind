import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

const lakeChip = (id: string, title: string, withPassage = true): CitableSource => ({
  id,
  type: 'document',
  title,
  url: `/opti?mode=datalake&article=${id}`,
  status: 'complete',
  metadata: {
    sourceSystem: 'knowledge_base',
    ...(withPassage ? { chunkId: `chunk-${id}`, fullContext: `Passage of ${id}.` } : {}),
  },
});

const ui = (citables: CitableSource[], sessionId: string) => (
  <CssVarsProvider theme={appTheme}>
    <NotebookCitationHost sessionId={sessionId}>
      <CitableSources citables={citables} />
    </NotebookCitationHost>
  </CssVarsProvider>
);

const renderInHost = (citables: CitableSource[], sessionId = 'session-A') => {
  const result = render(ui(citables, sessionId));
  return { ...result, switchTo: (next: string) => result.rerender(ui(citables, next)) };
};

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('NotebookCitationHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useSessionLayout.setState({
      layout: 'hide',
      previewFile: null,
      citedPassage: null,
      selectedArtifactId: undefined,
      artifactData: undefined,
    });
  });

  afterEach(() => vi.restoreAllMocks());

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

  it('clears a prior anchor when the chip is file-level and carries no passage', async () => {
    useSessionLayout.setState({ citedPassage: { fileId: 'other', chunkId: 'c0', passage: 'stale text' } });
    getFabFileByIdFromServer.mockResolvedValue({ id: 'file-1', fileName: 'Leave policy.md' });
    renderInHost([lakeChip('file-1', 'Leave policy.md', false)]);

    fireEvent.click(screen.getByTestId('citable-source-chip'));

    await waitFor(() => expect(useSessionLayout.getState().previewFile).toMatchObject({ id: 'file-1' }));
    expect(useSessionLayout.getState().citedPassage).toBeNull();
  });

  it('selects the cited file even when an artifact was already open', async () => {
    // The store keeps a prior artifact selected on a layout change unless the caller names its own;
    // the viewer would otherwise stay on the old tab while the cited file sits unselected.
    useSessionLayout.setState({
      layout: 'hide',
      artifactData: { id: 'old-artifact', type: 'code', content: '', mimeType: 'text/plain' },
      selectedArtifactId: 'old-artifact',
    });
    getFabFileByIdFromServer.mockResolvedValue({ id: 'file-1', fileName: 'Leave policy.md' });
    renderInHost([lakeChip('file-1', 'Leave policy.md')]);

    fireEvent.click(screen.getByTestId('citable-source-chip'));

    await waitFor(() => expect(useSessionLayout.getState().previewFile).toMatchObject({ id: 'file-1' }));
    expect(useSessionLayout.getState().selectedArtifactId).toBe('file-1');
  });

  it('reports the failure and falls back to the article route when the file cannot be fetched', async () => {
    getFabFileByIdFromServer.mockRejectedValue(new Error('403'));
    renderInHost([lakeChip('file-1', 'Leave policy.md')]);

    fireEvent.click(screen.getByTestId('citable-source-chip'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not open "Leave policy.md"'));
    expect(console.error).toHaveBeenCalled();
    expect(useSessionLayout.getState().layout).toBe('hide');
    expect(useSessionLayout.getState().previewFile).toBeNull();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/opti', search: { mode: 'datalake', article: 'file-1' } })
    );
  });

  it('leaves a relative chip that is not a lake article to the default navigation', () => {
    // A link to a notebook quest has no `article` param and its id is not a file id.
    const questChip: CitableSource = {
      id: 'quest-1',
      type: 'database',
      title: 'Quest: leave policy',
      url: '/notebooks/session-9?questId=quest-1',
      status: 'complete',
      metadata: { sourceSystem: 'database' },
    };
    renderInHost([questChip]);

    fireEvent.click(screen.getByTestId('citable-source-chip'));

    expect(getFabFileByIdFromServer).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/notebooks/session-9', search: { questId: 'quest-1' } })
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  describe('overlapping clicks', () => {
    const twoChips = [lakeChip('file-1', 'First.md'), lakeChip('file-2', 'Second.md')];

    it('opens only the latest click when an earlier fetch resolves late', async () => {
      const first = deferred<{ id: string }>();
      getFabFileByIdFromServer.mockImplementation((id: string) =>
        id === 'file-1' ? first.promise : Promise.resolve({ id })
      );
      renderInHost(twoChips);

      const [chip1, chip2] = screen.getAllByTestId('citable-source-chip');
      fireEvent.click(chip1);
      fireEvent.click(chip2);
      await waitFor(() => expect(useSessionLayout.getState().previewFile).toMatchObject({ id: 'file-2' }));

      await act(async () => first.resolve({ id: 'file-1' }));

      expect(useSessionLayout.getState().previewFile).toMatchObject({ id: 'file-2' });
    });

    it('stays silent when an earlier fetch REJECTS after a later click', async () => {
      const first = deferred<{ id: string }>();
      getFabFileByIdFromServer.mockImplementation((id: string) =>
        id === 'file-1' ? first.promise : Promise.resolve({ id })
      );
      renderInHost(twoChips);

      const [chip1, chip2] = screen.getAllByTestId('citable-source-chip');
      fireEvent.click(chip1);
      fireEvent.click(chip2);
      await waitFor(() => expect(useSessionLayout.getState().previewFile).toMatchObject({ id: 'file-2' }));

      await act(async () => first.reject(new Error('500')));

      expect(toastError).not.toHaveBeenCalled();
      expect(useSessionLayout.getState().previewFile).toMatchObject({ id: 'file-2' });
    });
  });

  describe('leaving mid-fetch', () => {
    it('drops a fetch that resolves after the host unmounts', async () => {
      const pending = deferred<{ id: string }>();
      getFabFileByIdFromServer.mockReturnValue(pending.promise);
      const { unmount } = renderInHost([lakeChip('file-1', 'Leave policy.md')]);

      fireEvent.click(screen.getByTestId('citable-source-chip'));
      unmount();
      await act(async () => pending.resolve({ id: 'file-1' }));

      expect(useSessionLayout.getState().previewFile).toBeNull();
      expect(useSessionLayout.getState().layout).toBe('hide');
    });

    it('drops a fetch when a later non-lake internal chip navigates away', async () => {
      const pending = deferred<{ id: string }>();
      getFabFileByIdFromServer.mockReturnValue(pending.promise);
      const questChip: CitableSource = {
        id: 'quest-1',
        type: 'database',
        title: 'Quest: leave policy',
        url: '/notebooks/session-9?questId=quest-1',
        status: 'complete',
        metadata: { sourceSystem: 'database' },
      };
      renderInHost([lakeChip('file-1', 'Leave policy.md'), questChip]);

      const [lake, quest] = screen.getAllByTestId('citable-source-chip');
      fireEvent.click(lake);
      fireEvent.click(quest);
      await act(async () => pending.resolve({ id: 'file-1' }));

      expect(navigate).toHaveBeenCalledTimes(1);
      expect(useSessionLayout.getState().previewFile).toBeNull();
      expect(useSessionLayout.getState().layout).toBe('hide');
    });
  });

  describe('switching notebooks mid-fetch', () => {
    it('does not open the file in the notebook the reader moved to', async () => {
      const pending = deferred<{ id: string }>();
      getFabFileByIdFromServer.mockReturnValue(pending.promise);
      const { switchTo } = renderInHost([lakeChip('file-1', 'Leave policy.md')], 'session-A');

      fireEvent.click(screen.getByTestId('citable-source-chip'));
      switchTo('session-B');
      await act(async () => pending.resolve({ id: 'file-1' }));

      expect(useSessionLayout.getState().previewFile).toBeNull();
      expect(useSessionLayout.getState().layout).toBe('hide');
    });

    it('does not toast a failure for a fetch started in the previous notebook', async () => {
      const pending = deferred<{ id: string }>();
      getFabFileByIdFromServer.mockReturnValue(pending.promise);
      const { switchTo } = renderInHost([lakeChip('file-1', 'Leave policy.md')], 'session-A');

      fireEvent.click(screen.getByTestId('citable-source-chip'));
      switchTo('session-B');
      await act(async () => pending.reject(new Error('404')));

      expect(toastError).not.toHaveBeenCalled();
    });

    it('still opens a file clicked after the switch', async () => {
      getFabFileByIdFromServer.mockResolvedValue({ id: 'file-1', fileName: 'Leave policy.md' });
      const { switchTo } = renderInHost([lakeChip('file-1', 'Leave policy.md')], 'session-A');

      switchTo('session-B');
      fireEvent.click(screen.getByTestId('citable-source-chip'));

      await waitFor(() => expect(useSessionLayout.getState().previewFile).toMatchObject({ id: 'file-1' }));
    });
  });
});
