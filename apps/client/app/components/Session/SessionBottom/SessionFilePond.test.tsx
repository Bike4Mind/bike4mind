import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { mockUploadComposerFile } = vi.hoisted(() => ({ mockUploadComposerFile: vi.fn() }));

// Capture the `server.process` FilePond would drive, so the test can run it without a DOM file input.
let capturedProcess: ((...a: unknown[]) => { abort: () => void }) | null = null;

vi.mock('react-filepond', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub stands in for the FilePond component
  FilePond: (props: any) => {
    capturedProcess = props.server?.process ?? null;
    return null;
  },
}));

vi.mock('@client/app/utils/filesAPICalls', () => ({ deleteFileUtility: vi.fn() }));
vi.mock('./uploadComposerFile', () => ({ uploadComposerFile: mockUploadComposerFile }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));

import { SessionFilePond } from './SessionFilePond';

const appTheme = extendTheme({ ...getThemeConfig() });

type FilePondItem = { file: File };

/** Runs the captured FilePond `process` for one file and resolves when its upload settled. */
async function processFile(file: File, otherItems: FilePondItem[] = []) {
  const setFiles = vi.fn();
  const load = vi.fn();
  const error = vi.fn();
  render(
    <CssVarsProvider theme={appTheme}>
      <SessionFilePond
        pond={{ current: null }}
        files={[]}
        setFiles={setFiles}
        maxFileSizeForFilePond="10MB"
        attachScopeMode="auto"
        currentSessionId="session-1"
        addToNotebookContext={vi.fn()}
      />
    </CssVarsProvider>
  );
  const handle = capturedProcess!('content', file, {}, load, error, vi.fn(), vi.fn());
  await new Promise(r => setTimeout(r, 0));
  // What the pond would keep after every setFiles updater ran.
  const remaining = () =>
    setFiles.mock.calls.reduce<FilePondItem[]>(
      (items, [updater]) => (updater as (p: FilePondItem[]) => FilePondItem[])(items),
      [{ file }, ...otherItems]
    );
  return { handle, load, error, setFiles, remaining };
}

const pdf = () => new File(['x'], 'roster.pdf', { type: 'application/pdf' });

describe('SessionFilePond', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcess = null;
  });

  it('hands FilePond the server id once the upload resolves', async () => {
    mockUploadComposerFile.mockResolvedValue({ id: 'f1' });

    const { load, error } = await processFile(pdf());

    expect(load).toHaveBeenCalledWith('f1');
    expect(error).not.toHaveBeenCalled();
  });

  it('marks the hidden FilePond item failed when the upload fails', async () => {
    mockUploadComposerFile.mockRejectedValue(new Error('boom'));

    const { error } = await processFile(pdf());

    expect(error).toHaveBeenCalledWith('Failed to upload file');
  });

  it('drops its item without an error when the upload was cancelled from the tile', async () => {
    mockUploadComposerFile.mockRejectedValue(new DOMException('Upload cancelled', 'AbortError'));
    const other = { file: new File(['y'], 'other.pdf') };

    const { error, remaining } = await processFile(pdf(), [other]);

    expect(error).not.toHaveBeenCalled();
    expect(remaining()).toEqual([other]);
  });

  it('aborts the upload through FilePond', async () => {
    mockUploadComposerFile.mockReturnValue(new Promise(() => {}));

    const { handle } = await processFile(pdf());
    const signal = (mockUploadComposerFile.mock.calls[0]![2] as { signal: AbortSignal }).signal;
    handle.abort();

    expect(signal.aborted).toBe(true);
  });
});
