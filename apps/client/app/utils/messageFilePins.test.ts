import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@client/app/contexts/SessionsContext', async () => {
  const { create } = await import('zustand');
  const useWorkBenchStore = create<{
    files: Record<string, IFabFileDocument[]>;
    setWorkBenchFiles: (sid: string, u: (p: IFabFileDocument[]) => IFabFileDocument[]) => void;
    getWorkBenchFiles: (sid: string) => IFabFileDocument[];
  }>((set, get) => ({
    files: {},
    setWorkBenchFiles: (sid, u) => set(s => ({ files: { ...s.files, [sid]: u(s.files[sid] ?? []) } })),
    getWorkBenchFiles: sid => get().files[sid] ?? [],
  }));
  return { useWorkBenchStore };
});
import type { IFabFileDocument } from '@bike4mind/common';
import type { PendingMessageFile } from '@client/app/hooks/useSessionLayout';
import {
  filesPinnedBySend,
  holdMirroredPinsUntilAgentStart,
  messageOnlyFileIds,
  mirrorPinnedMessageFiles,
  rollbackMirroredPins,
  settleMirroredPinsOnAgentStart,
} from '@client/app/utils/messageFilePins';
import { useWorkBenchStore } from '@client/app/contexts/SessionsContext';

const file = (id: string, mimeType: string) => ({ id, mimeType, fileName: id }) as IFabFileDocument;
const pending = (fabFile: IFabFileDocument, scope: PendingMessageFile['scope']): PendingMessageFile => ({
  fabFile,
  uploadProgress: 100,
  status: 'complete',
  scope,
});

describe('messageFilePins', () => {
  const csv = file('csv', 'text/csv');
  const png = file('png', 'image/png');
  const note = file('note', 'text/plain');
  const files = [pending(csv, 'notebook'), pending(png, 'notebook'), pending(note, 'message')];

  it('lists only the attachments scoped to this message', () => {
    expect(messageOnlyFileIds(files)).toEqual(['note']);
  });

  it('mirrors the documents the server pins, and nothing the workbench already holds or that was not sent', () => {
    expect(filesPinnedBySend(files, ['csv', 'png', 'note'], [])).toEqual([csv]);
    expect(filesPinnedBySend(files, ['csv'], [csv])).toEqual([]);
    expect(filesPinnedBySend(files, ['png', 'note'], [])).toEqual([]);
  });

  describe('mirror lifecycle', () => {
    const SID = 'sess-1';
    const ids = () =>
      useWorkBenchStore
        .getState()
        .getWorkBenchFiles(SID)
        .map(f => f.id);
    const setRaw = vi.fn();

    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- resetting the test double's state
      (useWorkBenchStore as any).setState({ files: { [SID]: [file('kept', 'text/plain')] } });
    });

    it('rolls back only what it added when the send fails', () => {
      const added = mirrorPinnedMessageFiles(SID, files, ['csv', 'png'], setRaw);
      expect(added).toEqual(['csv']);
      expect(ids()).toEqual(['kept', 'csv']);
      rollbackMirroredPins(SID, added, setRaw);
      expect(ids()).toEqual(['kept']);
    });

    it('keeps the agent mirror when the start is acknowledged, drops it when refused', () => {
      holdMirroredPinsUntilAgentStart(SID, mirrorPinnedMessageFiles(SID, files, ['csv'], setRaw));
      settleMirroredPinsOnAgentStart(SID, true);
      expect(ids()).toEqual(['kept', 'csv']);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- resetting the test double's state
      (useWorkBenchStore as any).setState({ files: { [SID]: [] } });
      holdMirroredPinsUntilAgentStart(SID, mirrorPinnedMessageFiles(SID, files, ['csv'], setRaw));
      settleMirroredPinsOnAgentStart(SID, false);
      expect(ids()).toEqual([]);
    });
  });
});
