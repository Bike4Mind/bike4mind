import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import type { IUserDocument } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';

const { mockCreateFabFile, mockDeleteFile, toastMock } = vi.hoisted(() => ({
  mockCreateFabFile: vi.fn(),
  mockDeleteFile: vi.fn(),
  toastMock: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@client/app/utils/filesAPICalls', () => ({
  createFabFileOnServerWithUpload: (...a: unknown[]) => mockCreateFabFile(...a),
  deleteFileUtility: (...a: unknown[]) => mockDeleteFile(...a),
}));
vi.mock('sonner', () => ({ toast: toastMock }));

import useSessionLayout, { recordModerationStatus, setPendingMessageFiles } from '@client/app/hooks/useSessionLayout';
import { cancelComposerUpload, uploadComposerFile, type ComposerUploadContext } from './uploadComposerFile';

const SID = 'session-1';

const pending = () => useSessionLayout.getState().pendingMessageFiles ?? [];

const makeContext = (
  attachScopeMode: ComposerUploadContext['attachScopeMode'] = 'auto',
  addToNotebookContext = vi.fn().mockResolvedValue(true)
): ComposerUploadContext => ({
  attachScopeMode,
  currentSessionId: SID,
  addToNotebookContext,
  queryClient: { getQueryData: () => undefined, invalidateQueries: vi.fn() } as unknown as QueryClient,
});

const makeFile = (name: string, type: string) => new File(['x'], name, { type });
const pdf = () => makeFile('roster.pdf', 'application/pdf');
const png = () => makeFile('shot.png', 'image/png');

/** Resolves the upload request only once the test says so, or rejects like axios when aborted. */
const holdUploadUntilAborted = () =>
  mockCreateFabFile.mockImplementation(
    (_input: unknown, _file: File, signal: AbortSignal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Upload cancelled', 'AbortError')));
      })
  );

describe('uploadComposerFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteFile.mockResolvedValue(undefined);
    setPendingMessageFiles([]);
    useSessionLayout.setState({ pendingModerationEvents: {} });
  });

  describe('attachment scope', () => {
    it('promotes a document to notebook context on the default path', async () => {
      // An ordinary document upload, no toggles touched, must reach session.knowledgeIds.
      // If the default ever reverts to per-message, this fails.
      const context = makeContext('auto');
      mockCreateFabFile.mockResolvedValue({ id: 'f1', fileName: 'roster.pdf', mimeType: 'application/pdf' });

      await uploadComposerFile(pdf(), context);

      expect(context.addToNotebookContext).toHaveBeenCalledOnce();
      expect(context.addToNotebookContext).toHaveBeenCalledWith(SID, expect.objectContaining({ id: 'f1' }), {
        propagateToProjects: false,
      });
    });

    it('does NOT promote an image on the default path', async () => {
      // An image is re-encoded into every turn it is attached to, so persisting one by
      // default is an unbounded token cost the user never asked for.
      const context = makeContext('auto');
      mockCreateFabFile.mockResolvedValue({ id: 'img1', fileName: 'shot.png', mimeType: 'image/png' });

      await uploadComposerFile(png(), context);

      expect(context.addToNotebookContext).not.toHaveBeenCalled();
    });

    it('does NOT promote an opted-in image at upload time; that waits for the moderation scan', async () => {
      const context = makeContext('notebook');
      mockCreateFabFile.mockResolvedValue({ id: 'img1', fileName: 'shot.png', mimeType: 'image/png' });

      await uploadComposerFile(png(), context);

      expect(context.addToNotebookContext).not.toHaveBeenCalled();
      expect(pending()[0]).toMatchObject({ status: 'scanning' });
    });

    it('promotes an opted-in image whose clean scan arrived before the id swap', async () => {
      // The WS promotion path matches on the real FabFile id. When the scan beats the
      // temp-id swap the event is buffered instead, so consuming the buffer is the last chance.
      const context = makeContext('notebook');
      mockCreateFabFile.mockResolvedValue({ id: 'img1', fileName: 'shot.png', mimeType: 'image/png' });
      recordModerationStatus('img1', 'clean', 'https://cdn.example/shot.png');

      await uploadComposerFile(png(), context);

      // The upload response still says 'pending'; the hook's scan guard needs the buffered verdict.
      expect(context.addToNotebookContext).toHaveBeenCalledWith(
        SID,
        expect.objectContaining({ id: 'img1', moderationStatus: 'clean', fileUrl: 'https://cdn.example/shot.png' }),
        { propagateToProjects: false }
      );
      expect(pending()[0]).toMatchObject({ status: 'complete' });
    });

    it('does NOT promote when the buffered scan says blocked', async () => {
      const context = makeContext('notebook');
      mockCreateFabFile.mockResolvedValue({ id: 'img1', fileName: 'shot.png', mimeType: 'image/png' });
      recordModerationStatus('img1', 'blocked');

      await uploadComposerFile(png(), context);

      expect(context.addToNotebookContext).not.toHaveBeenCalled();
      expect(pending()[0]).toMatchObject({ status: 'blocked' });
    });

    it('honours an explicit per-message override for a document', async () => {
      const context = makeContext('message');
      mockCreateFabFile.mockResolvedValue({ id: 'f1', fileName: 'roster.pdf', mimeType: 'application/pdf' });

      await uploadComposerFile(pdf(), context);

      expect(context.addToNotebookContext).not.toHaveBeenCalled();
    });
  });

  describe('pending item', () => {
    it('starts as an uploading item carrying the frozen scope, the session and the local file', async () => {
      holdUploadUntilAborted();
      const file = pdf();

      const upload = uploadComposerFile(file, makeContext('auto'));
      await vi.waitFor(() => expect(mockCreateFabFile).toHaveBeenCalled());

      // uploadSessionId is frozen alongside scope so a deferred image promotion cannot file
      // the file under whichever notebook the user switched to meanwhile.
      const [item] = pending();
      expect(item).toMatchObject({ status: 'uploading', scope: 'notebook', uploadSessionId: SID, localFile: file });
      expect(item!.clientId).toBe(item!.fabFile.id);
      expect(item!.clientId).toMatch(/^temp-/);

      cancelComposerUpload(item!.clientId!);
      await expect(upload).rejects.toThrow();
    });

    it('swaps in the real file, keeping the frozen scope, the client id and the local file', async () => {
      mockCreateFabFile.mockResolvedValue({ id: 'f1', fileName: 'roster.pdf', mimeType: 'application/pdf' });
      const file = pdf();

      await uploadComposerFile(file, makeContext('auto'));

      const [item] = pending();
      expect(item).toMatchObject({
        fabFile: { id: 'f1' },
        status: 'complete',
        uploadProgress: 100,
        scope: 'notebook',
        localFile: file,
      });
      expect(item!.clientId).toMatch(/^temp-/);
    });

    it('marks a failed upload errored with its reason', async () => {
      mockCreateFabFile.mockRejectedValue(new Error('File type .zip is not supported'));

      await expect(uploadComposerFile(makeFile('a.zip', 'application/zip'), makeContext())).rejects.toThrow();

      expect(pending()[0]).toMatchObject({ status: 'error', errorMessage: 'File type .zip is not supported' });
    });

    it('does not show a raw response body (S3 XML, gateway HTML) as the reason', async () => {
      mockCreateFabFile.mockRejectedValue({
        isAxiosError: true,
        message: 'Request failed with status code 403',
        response: { status: 403, data: '<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>' },
      });

      await expect(uploadComposerFile(pdf(), makeContext())).rejects.toBeDefined();

      expect(pending()[0]).toMatchObject({ status: 'error' });
      expect(pending()[0]!.errorMessage).toBeUndefined();
    });
  });

  describe('cancellation', () => {
    it('removing the tile mid-upload aborts it, drops the item and never promotes the file', async () => {
      holdUploadUntilAborted();
      const context = makeContext('auto');

      const upload = uploadComposerFile(pdf(), context);
      await vi.waitFor(() => expect(mockCreateFabFile).toHaveBeenCalled());
      cancelComposerUpload(pending()[0]!.fabFile.id);

      await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
      expect(pending()).toEqual([]);
      expect(context.addToNotebookContext).not.toHaveBeenCalled();
    });

    it('deletes the server file when the cancel lands just as the request resolved', async () => {
      const context = makeContext('auto');
      mockCreateFabFile.mockImplementation(async () => {
        cancelComposerUpload(pending()[0]!.fabFile.id);
        return { id: 'f1', fileName: 'roster.pdf', mimeType: 'application/pdf' };
      });

      await expect(uploadComposerFile(pdf(), context)).rejects.toMatchObject({ name: 'AbortError' });

      expect(mockDeleteFile).toHaveBeenCalledWith('f1');
      expect(pending()).toEqual([]);
      expect(context.addToNotebookContext).not.toHaveBeenCalled();
    });

    it('also aborts through the caller signal', async () => {
      holdUploadUntilAborted();
      const controller = new AbortController();

      const upload = uploadComposerFile(pdf(), makeContext(), { signal: controller.signal });
      await vi.waitFor(() => expect(mockCreateFabFile).toHaveBeenCalled());
      controller.abort();

      await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
      expect(pending()).toEqual([]);
    });

    it('ignores an id that is not uploading', () => {
      expect(() => cancelComposerUpload('f1')).not.toThrow();
    });
  });

  describe('storage limit', () => {
    const refreshUser = vi.fn(() => Promise.resolve());
    // 1 MB limit, stored in MB like the real user document.
    const setUsage = (currentStorageSize: number) =>
      useUser.setState({ currentUser: { currentStorageSize, storageLimit: 1 } as IUserDocument, refreshUser });

    beforeEach(() => {
      refreshUser.mockClear().mockImplementation(() => Promise.resolve());
    });

    afterEach(() => {
      useUser.setState({ currentUser: null });
    });

    const notes = () => makeFile('notes.txt', 'text/plain');

    it('refuses over the limit before any server call, on the tile and in a toast', async () => {
      setUsage(1_000_000);

      await expect(uploadComposerFile(notes(), makeContext())).rejects.toThrow();

      expect(mockCreateFabFile).not.toHaveBeenCalled();
      expect(refreshUser).toHaveBeenCalled();
      expect(pending()[0]!.errorMessage).toMatch(/Free up at least/);
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/Free up at least/), expect.anything());
    });

    it('warns near the limit but still uploads', async () => {
      setUsage(950_000);
      mockCreateFabFile.mockResolvedValue({ id: 'f1', fileName: 'notes.txt', mimeType: 'text/plain' });

      await uploadComposerFile(notes(), makeContext());

      expect(toastMock.warning).toHaveBeenCalledWith(
        expect.stringMatching(/close to your storage limit/),
        expect.anything()
      );
      expect(mockCreateFabFile).toHaveBeenCalled();
    });

    it("shows the server's used, limit and requested numbers when the client check passed", async () => {
      setUsage(0);
      mockCreateFabFile.mockRejectedValue({
        isAxiosError: true,
        message: 'Request failed with status code 400',
        response: {
          status: 400,
          data: {
            error: 'File size exceeds storage limit',
            errorCode: 'storage_limit_exceeded',
            used_bytes: 800_000,
            limit_bytes: 1_000_000,
            requested_bytes: 300_000,
            owner: 'user',
          },
        },
      });

      await expect(uploadComposerFile(notes(), makeContext())).rejects.toBeDefined();

      expect(pending()[0]!.errorMessage).toMatch(/800 kB of 1 MB.*Free up at least 100 kB/);
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/800 kB of 1 MB.*Free up at least 100 kB/),
        expect.anything()
      );
    });

    it('surfaces a legacy server refusal with no code verbatim when the client check passed', async () => {
      setUsage(0);
      mockCreateFabFile.mockRejectedValue({
        isAxiosError: true,
        message: 'Request failed with status code 400',
        response: { status: 400, data: { error: 'File size exceeds storage limit' } },
      });

      await expect(uploadComposerFile(notes(), makeContext())).rejects.toBeDefined();

      expect(pending()[0]!.errorMessage).toBe('File size exceeds storage limit');
      expect(toastMock.error).toHaveBeenCalledWith('File size exceeds storage limit', expect.anything());
    });

    it('does not judge an oversized image against the flat resize cap alone', async () => {
      // Limit 4 MB, used 1 MB, a 4,000,000-byte JPEG: the flat cap estimate (3 MB) would exceed,
      // but the true post-resize size (as low as 85% of that cap) fits, so this must not be blocked.
      useUser.setState({
        currentUser: { currentStorageSize: 1_000_000, storageLimit: 4 } as IUserDocument,
        refreshUser,
      });
      mockCreateFabFile.mockResolvedValue({ id: 'img1', fileName: 'shot.jpg', mimeType: 'image/jpeg' });
      const big = makeFile('shot.jpg', 'image/jpeg');
      Object.defineProperty(big, 'size', { value: 4_000_000 });

      await uploadComposerFile(big, makeContext());

      expect(mockCreateFabFile).toHaveBeenCalled();
    });
  });
});
