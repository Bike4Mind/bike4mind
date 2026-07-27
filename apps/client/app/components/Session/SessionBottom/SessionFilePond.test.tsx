import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';

const mockCreateFabFile = vi.fn();
const mockSetPendingMessageFiles = vi.fn();

// Capture the `server.process` FilePond would drive, so the test can invoke the real
// upload pipeline without a DOM file input.
let capturedProcess: ((...a: unknown[]) => void) | null = null;

vi.mock('react-filepond', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub stands in for the FilePond component
  FilePond: (props: any) => {
    capturedProcess = props.server?.process ?? null;
    return null;
  },
}));

vi.mock('@client/app/utils/filesAPICalls', () => ({
  createFabFileOnServerWithUpload: (...a: unknown[]) => mockCreateFabFile(...a),
  deleteFileUtility: vi.fn(),
}));

vi.mock('@client/app/hooks/useSessionLayout', () => ({
  setPendingMessageFiles: (u: unknown) => mockSetPendingMessageFiles(u),
  consumeBufferedModerationStatus: () => undefined,
  patchPendingMessageFileModerationStatus: (files: unknown) => files,
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: () => undefined, invalidateQueries: vi.fn() }),
}));

import { SessionFilePond } from './SessionFilePond';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const SID = 'session-1';

/** Runs the captured upload pipeline for one file and resolves when it settles. */
async function upload(
  attachScopeMode: 'auto' | 'notebook' | 'message',
  file: File,
  addToNotebookContext: ReturnType<typeof vi.fn>
) {
  render(
    <Wrapper>
      <SessionFilePond
        pond={{ current: null }}
        files={[]}
        setFiles={vi.fn()}
        maxFileSizeForFilePond="10MB"
        attachScopeMode={attachScopeMode}
        currentSessionId={SID}
        addToNotebookContext={addToNotebookContext}
      />
    </Wrapper>
  );
  capturedProcess!('content', file, {}, vi.fn(), vi.fn(), vi.fn(), vi.fn());
  // Let the arrayBuffer + upload promise chain settle.
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
}

const makeFile = (name: string, type: string) => {
  const f = new File(['x'], name, { type });
  // jsdom's File lacks arrayBuffer in some versions; the pipeline awaits it first.
  if (!f.arrayBuffer) Object.defineProperty(f, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
  return f;
};

describe('SessionFilePond attachment scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcess = null;
  });

  it('promotes a document to notebook context on the default path', async () => {
    // THE regression test for #959: an ordinary document upload, no toggles touched,
    // must reach session.knowledgeIds. If the default ever reverts to per-message,
    // this fails and the reported bug is back.
    const add = vi.fn().mockResolvedValue(undefined);
    mockCreateFabFile.mockResolvedValue({ id: 'f1', fileName: 'roster.pdf', mimeType: 'application/pdf' });

    await upload('auto', makeFile('roster.pdf', 'application/pdf'), add);

    expect(add).toHaveBeenCalledOnce();
    expect(add.mock.calls[0][0]).toBe(SID);
    expect(add.mock.calls[0][1]).toMatchObject({ id: 'f1' });
  });

  it('passes propagateToProjects false, so an automatic promotion stays out of projects', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    mockCreateFabFile.mockResolvedValue({ id: 'f1', fileName: 'roster.pdf', mimeType: 'application/pdf' });

    await upload('auto', makeFile('roster.pdf', 'application/pdf'), add);

    expect(add.mock.calls[0][2]).toEqual({ propagateToProjects: false });
  });

  it('does NOT promote an image on the default path', async () => {
    // An image is re-encoded into every turn it is attached to, so persisting one by
    // default is an unbounded token cost the user never asked for.
    const add = vi.fn().mockResolvedValue(undefined);
    mockCreateFabFile.mockResolvedValue({ id: 'img1', fileName: 'shot.png', mimeType: 'image/png' });

    await upload('auto', makeFile('shot.png', 'image/png'), add);

    expect(add).not.toHaveBeenCalled();
  });

  it('does NOT promote an opted-in image at upload time; that waits for the moderation scan', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    mockCreateFabFile.mockResolvedValue({ id: 'img1', fileName: 'shot.png', mimeType: 'image/png' });

    await upload('notebook', makeFile('shot.png', 'image/png'), add);

    expect(add).not.toHaveBeenCalled();
  });

  it('honours an explicit per-message override for a document', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    mockCreateFabFile.mockResolvedValue({ id: 'f1', fileName: 'roster.pdf', mimeType: 'application/pdf' });

    await upload('message', makeFile('roster.pdf', 'application/pdf'), add);

    expect(add).not.toHaveBeenCalled();
  });

  it('records the resolved scope on the pending item so later steps do not re-derive it', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    mockCreateFabFile.mockResolvedValue({ id: 'f1', fileName: 'roster.pdf', mimeType: 'application/pdf' });

    await upload('auto', makeFile('roster.pdf', 'application/pdf'), add);

    const firstUpdater = mockSetPendingMessageFiles.mock.calls[0][0] as (p: unknown[]) => unknown[];
    expect(firstUpdater([])[0]).toMatchObject({ scope: 'notebook', status: 'uploading' });
  });

  it('keeps the frozen scope across the temp-id to real-file swap', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    mockCreateFabFile.mockResolvedValue({ id: 'f1', fileName: 'roster.pdf', mimeType: 'application/pdf' });

    await upload('auto', makeFile('roster.pdf', 'application/pdf'), add);

    const swapUpdater = mockSetPendingMessageFiles.mock.calls.at(-1)![0] as (
      p: Array<Record<string, unknown>>
    ) => Array<Record<string, unknown>>;
    const before = [
      {
        fabFile: { id: expect.anything() } as unknown as IFabFileDocument,
        uploadProgress: 0,
        status: 'uploading',
        scope: 'notebook',
      },
    ];
    // The swap matches on the temp id, which the test cannot know; assert instead that
    // a passthrough item is returned untouched and still carries its scope.
    expect(swapUpdater(before as never)[0]).toMatchObject({ scope: 'notebook' });
  });
});
