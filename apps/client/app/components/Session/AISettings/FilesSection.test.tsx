import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';

const mockAdd = vi.fn().mockResolvedValue(undefined);
const mockRemove = vi.fn().mockResolvedValue(undefined);
const mockIsPending = vi.fn().mockReturnValue(false);

let messageFiles: IFabFileDocument[] = [];
let workBenchFiles: IFabFileDocument[] = [];
let currentUserId = 'me';
let sessionUserId = 'me';

vi.mock('@client/app/hooks/useNotebookContextFiles', () => ({
  useNotebookContextFiles: () => ({
    addToNotebookContext: mockAdd,
    removeFromNotebookContext: mockRemove,
    isPending: (id: string) => mockIsPending(id),
  }),
}));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSessionId: 's1', currentSession: { id: 's1', userId: sessionUserId } }),
  useSystemPromptFiles: () => ({ systemFiles: [], globalSystemFileIds: [], userSystemFileIds: [] }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
  useWorkBenchFiles: () => workBenchFiles,
}));

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: currentUserId } }) }));
vi.mock('@client/app/hooks/useMessageFiles', () => ({ useMessageFiles: () => messageFiles }));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: () => undefined }));
vi.mock('@client/app/hooks/data/fabFiles', () => ({ useChunkFile: () => ({ mutateAsync: vi.fn() }) }));
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
    currentUserId = 'me';
    sessionUserId = 'me';
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

  it('renders nothing when there are no files of any kind', () => {
    const { container } = renderPanel();
    expect(container.firstChild).toBeNull();
  });
});
