import { describe, it, expect } from 'vitest';
import type { IFabFileDocument } from '@bike4mind/common';
import type { PendingMessageFile } from '@client/app/hooks/useSessionLayout';
import { filesPinnedBySend, messageOnlyFileIds } from './messageFilePins';

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
});
