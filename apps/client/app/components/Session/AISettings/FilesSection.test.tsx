import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';

const mockAdd = vi.fn().mockResolvedValue(undefined);
const mockRemove = vi.fn().mockResolvedValue(undefined);
const mockIsPending = vi.fn().mockReturnValue(false);
const mockChunkMutate = vi.fn();
const mockReprocessMutate = vi.fn();
const { mockToastSuccess } = vi.hoisted(() => ({ mockToastSuccess: vi.fn() }));
const mockSetWorkBenchFiles = vi.fn();

let messageFiles: IFabFileDocument[] = [];
let workBenchFiles: IFabFileDocument[] = [];
let systemFiles: IFabFileDocument[] = [];
let currentUserId = 'me';
let sessionUserId = 'me';
// Keyed so a test can set only the setting it cares about; other keys stay undefined,
// matching the real useGetSettingsValue's per-key resolution.
let settingsValues: Record<string, unknown> = {};

vi.mock('@client/app/hooks/useNotebookContextFiles', () => ({
  useNotebookContextFiles: () => ({
    addToNotebookContext: mockAdd,
    removeFromNotebookContext: mockRemove,
    isPending: (id: string) => mockIsPending(id),
  }),
}));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: 's1', currentSession: { id: 's1', userId: sessionUserId } }),
  useSystemPromptFiles: () => ({ systemFiles, globalSystemFileIds: [], userSystemFileIds: [] }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: mockSetWorkBenchFiles }),
  useWorkBenchFiles: () => workBenchFiles,
}));

vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: vi.fn() } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: currentUserId } }) }));
vi.mock('@client/app/hooks/useMessageFiles', () => ({ useMessageFiles: () => messageFiles }));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: (key: string) => settingsValues[key] }));
// useChunkFile stays mocked even though FilesSection no longer calls it, so a regression that
// routes reprocess back through the non-resetting /api/files/chunk door fails on the assertion
// below rather than on a missing-export error.
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useChunkFile: () => ({ mutate: mockChunkMutate }),
  useReprocessFile: () => ({ mutate: mockReprocessMutate }),
}));
vi.mock('@client/app/hooks/useEmbeddingMismatchStatus', () => ({
  useEmbeddingMismatchStatus: () => ({ hasEmbeddingMismatch: () => false }),
}));
vi.mock('@client/app/components/Knowledge/KnowledgeViewer', () => ({ setKnowledgeViewer: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@client/app/hooks/useSessionLayout', () => ({
  default: (sel: (s: unknown) => unknown) => sel({ pendingMessageFiles: [], recentArtifacts: [] }),
  setSessionLayout: vi.fn(),
}));

import FilesSection from './FilesSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <FilesSection model="gpt" />
    </CssVarsProvider>
  );

const fab = (id: string, name: string, userId = 'me', mimeType = 'application/pdf'): IFabFileDocument =>
  ({ id, fileName: name, userId, mimeType }) as IFabFileDocument;

describe('FilesSection message-scoped files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPending.mockReturnValue(false);
    messageFiles = [];
    workBenchFiles = [];
    systemFiles = [];
    currentUserId = 'me';
    sessionUserId = 'me';
    settingsValues = {};
  });

  it('renders when the notebook has ONLY message-scoped files', () => {
    // The gating bug this locks: the panel used to early-return on
    // workBenchFiles + systemFiles alone, so a notebook whose only files are
    // message-scoped rendered nothing - hiding the promote action in exactly the
    // case it exists for. Counting messageFiles is what makes it reachable.
    messageFiles = [fab('m1', 'roster.pdf')];

    renderPanel();

    expect(screen.getByTestId('files-section-message-files-group')).toBeTruthy();
    expect(screen.getByTestId('files-section-promote-btn-m1')).toBeTruthy();
  });

  it('labels a message-scoped file as one-message', () => {
    messageFiles = [fab('m1', 'roster.pdf')];
    renderPanel();
    expect(screen.getByTestId('files-section-message-scope-chip-m1').textContent).toMatch(/one message/i);
  });

  it('promotes through the shared writer, leaving project propagation at its default', () => {
    messageFiles = [fab('m1', 'roster.pdf')];
    renderPanel();

    fireEvent.click(screen.getByTestId('files-section-promote-btn-m1'));

    expect(mockAdd).toHaveBeenCalledOnce();
    expect(mockAdd.mock.calls[0][0]).toBe('s1');
    expect(mockAdd.mock.calls[0][1]).toMatchObject({ id: 'm1' });
    // An explicit gesture, unlike an automatic upload promotion.
    expect(mockAdd.mock.calls[0][2]).toBeUndefined();
  });

  it('disables the promote button while its write is in flight', () => {
    messageFiles = [fab('m1', 'roster.pdf')];
    mockIsPending.mockImplementation((id: string) => id === 'm1');
    renderPanel();

    const btn = screen.getByTestId('files-section-promote-btn-m1') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('hides promote on someone else notebook for a file the user does not own', () => {
    messageFiles = [fab('m1', 'roster.pdf', 'someone-else')];
    sessionUserId = 'someone-else';
    renderPanel();

    expect(screen.queryByTestId('files-section-promote-btn-m1')).toBeNull();
  });

  it('refuses to promote an image that has not cleared moderation', () => {
    // A knowledgeIds entry follows the file into clones, exports and the project
    // fan-out, so an unscanned or blocked image must never acquire one.
    messageFiles = [{ ...fab('m1', 'shot.png', 'me', 'image/png'), moderationStatus: 'pending' } as IFabFileDocument];
    renderPanel();

    fireEvent.click(screen.getByTestId('files-section-promote-btn-m1'));

    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('promotes an image once it has cleared moderation', () => {
    messageFiles = [{ ...fab('m1', 'shot.png', 'me', 'image/png'), moderationStatus: 'clean' } as IFabFileDocument];
    renderPanel();

    fireEvent.click(screen.getByTestId('files-section-promote-btn-m1'));

    expect(mockAdd).toHaveBeenCalledOnce();
  });

  it('renders nothing when there are no files of any kind', () => {
    const { container } = renderPanel();
    expect(container.firstChild).toBeNull();
  });

  it('reprocesses a mismatched file through the state-resetting door, not the plain chunk call', () => {
    // /api/files/chunk leaves chunked: true in place, so the queue handler's duplicate-delivery
    // guard drops the message and the file is never re-embedded. Only /api/files/reprocess resets
    // the flags first. No chunkSize goes with it: the rebuild inherits the owner-altitude
    // DefaultChunkSize policy resolved server-side (this test previously asserted a clamped
    // client-side chunkSize, which the reprocess door does not and should not accept).
    settingsValues.DefaultChunkSize = 5000;
    settingsValues.defaultEmbeddingModel = 'model-b';
    workBenchFiles = [{ ...fab('w1', 'roster.pdf'), embeddingModel: 'model-a' } as IFabFileDocument];

    renderPanel();
    fireEvent.click(screen.getByTestId('files-section-reprocess-btn-workbench-w1'));

    expect(mockChunkMutate).not.toHaveBeenCalled();
    expect(mockReprocessMutate).toHaveBeenCalledOnce();
    expect(mockReprocessMutate.mock.calls[0][0]).toBe('w1');
  });

  it('reports the rebuild as started and does not mark the file complete off the queue ack', () => {
    settingsValues.defaultEmbeddingModel = 'model-b';
    workBenchFiles = [
      { ...fab('w1', 'roster.pdf'), embeddingModel: 'model-a', chunked: true, vectorized: true } as IFabFileDocument,
    ];

    renderPanel();
    fireEvent.click(screen.getByTestId('files-section-reprocess-btn-workbench-w1'));
    mockReprocessMutate.mock.calls[0][1].onSuccess();

    expect(mockToastSuccess).toHaveBeenCalledOnce();
    expect(mockToastSuccess.mock.calls[0][0]).toMatch(/Re-processing/);
    expect(mockToastSuccess.mock.calls[0][0]).not.toMatch(/Successfully reprocessed/);

    // The optimistic write must not claim the rebuild finished under the current model.
    expect(mockSetWorkBenchFiles).toHaveBeenCalledOnce();
    const updated = mockSetWorkBenchFiles.mock.calls[0][1](workBenchFiles);
    expect(updated[0]).toMatchObject({ chunked: false, vectorized: false });
    expect(updated[0].embeddingModel).not.toBe('model-b');
  });

  it('renders distinct reprocess testids when the same file id appears in both lists', () => {
    // Locks the fix: handleReprocessFile treats a file as possibly present in both the
    // system and workbench lists, so an unsuffixed testid would collide and getByTestId
    // would throw on more than one match.
    settingsValues.defaultEmbeddingModel = 'model-b';
    systemFiles = [{ ...fab('dup1', 'shared.pdf'), embeddingModel: 'model-a' } as IFabFileDocument];
    workBenchFiles = [{ ...fab('dup1', 'shared.pdf'), embeddingModel: 'model-a' } as IFabFileDocument];

    renderPanel();

    expect(screen.getByTestId('files-section-reprocess-btn-system-dup1')).toBeTruthy();
    expect(screen.getByTestId('files-section-reprocess-btn-workbench-dup1')).toBeTruthy();
  });
});
