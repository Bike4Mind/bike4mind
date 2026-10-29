import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';

const { mockUploadComposerFile, mockGenerateSmartFileName } = vi.hoisted(() => ({
  mockUploadComposerFile: vi.fn(),
  mockGenerateSmartFileName: vi.fn(),
}));

vi.mock('@client/app/components/Session/SessionBottom/uploadComposerFile', () => ({
  uploadComposerFile: mockUploadComposerFile,
}));
vi.mock('@client/app/utils/generateSmartFileName', () => ({ generateSmartFileName: mockGenerateSmartFileName }));
vi.mock('@client/app/components/Session/LexicalChatInput', () => ({}));

import { useChatPaste } from './useChatPaste';

const queryClient = { setQueriesData: vi.fn(), invalidateQueries: vi.fn() } as unknown as QueryClient;

const deps = () => ({
  attachScopeMode: 'auto' as const,
  currentSessionId: 'session-1',
  addToNotebookContext: vi.fn(),
  queryClient,
  currentSession: null,
  chatHistory: [],
  chatInputValue: '',
  setChatInputValue: vi.fn(),
  lexicalInputRef: { current: null },
});

const pasteEvent = (items: { type: string; file?: File }[], text = '') =>
  ({
    preventDefault: vi.fn(),
    clipboardData: {
      items: items.map(({ type, file }) => ({ type, getAsFile: () => file ?? null })),
      getData: () => text,
    },
  }) as unknown as ClipboardEvent;

describe('useChatPaste', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUploadComposerFile.mockResolvedValue({ id: 'f1' });
  });

  it('uploads a pasted image as a composer attachment under its generated name', async () => {
    mockGenerateSmartFileName.mockResolvedValue('screenshot-chart.png');
    const image = new File(['png'], 'image.png', { type: 'image/png' });
    const event = pasteEvent([{ type: 'image/png', file: image }]);
    const { result } = renderHook(() => useChatPaste(deps()));

    await expect(result.current(event)).resolves.toBe(true);

    expect(event.preventDefault).toHaveBeenCalled();
    const [uploaded, context] = mockUploadComposerFile.mock.calls[0]!;
    expect(uploaded).toBeInstanceOf(File);
    expect(uploaded).toMatchObject({ name: 'screenshot-chart.png', type: 'image/png' });
    expect(context).toMatchObject({ attachScopeMode: 'auto', currentSessionId: 'session-1', queryClient });
  });

  it('uploads more than 30 pasted lines as a text file', async () => {
    mockGenerateSmartFileName.mockResolvedValue('notes.txt');
    const text = Array.from({ length: 31 }, (_, i) => `line ${i}`).join('\n');
    const event = pasteEvent([], text);
    const { result } = renderHook(() => useChatPaste(deps()));

    await expect(result.current(event)).resolves.toBe(true);

    expect(event.preventDefault).toHaveBeenCalled();
    const [uploaded] = mockUploadComposerFile.mock.calls[0]!;
    expect(uploaded).toMatchObject({ name: 'notes.txt', type: 'text/plain' });
    await expect((uploaded as File).text()).resolves.toBe(text);
  });

  it('leaves a short paste to the editor', async () => {
    const event = pasteEvent([], 'hello');
    const { result } = renderHook(() => useChatPaste(deps()));

    await expect(result.current(event)).resolves.toBe(false);

    expect(mockUploadComposerFile).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('swallows a failed upload, which its tile already shows', async () => {
    mockGenerateSmartFileName.mockResolvedValue('image.png');
    mockUploadComposerFile.mockRejectedValue(new Error('boom'));
    const event = pasteEvent([{ type: 'image/png', file: new File(['png'], 'image.png', { type: 'image/png' }) }]);
    const { result } = renderHook(() => useChatPaste(deps()));

    await expect(result.current(event)).resolves.toBe(true);
    expect(queryClient.invalidateQueries).toHaveBeenCalled();
  });
});
