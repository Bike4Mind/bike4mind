import { describe, it, expect, beforeEach } from 'vitest';
import useSessionLayout, { setSessionLayout, clearSessionScopedViewerState } from './useSessionLayout';

/**
 * The citation anchor (#3038) is deliberately session-transient: it points into a document the
 * reader opened in THIS notebook, and nothing resolves its chunk id back to text, so an anchor that
 * outlives the session that set it can only mark the wrong thing or nothing at all.
 */
describe('useSessionLayout citation anchor lifetime', () => {
  beforeEach(() => {
    setSessionLayout({ previewFile: null, citedPassage: null });
  });

  const anchor = { fileId: 'file-a', chunkId: 'chunk-1', passage: 'Holidays accrue monthly.' };
  const previewFile = { id: 'file-a', fileName: 'Handbook.md' } as never;

  it('is NOT persisted', () => {
    // partialize is an allowlist, so this asserts the absence that keeps a reloaded tab from
    // marking a passage whose document is no longer open.
    setSessionLayout({ citedPassage: anchor });
    const persisted = JSON.parse(window.localStorage.getItem('layout-control') ?? '{}');
    expect(persisted.state).toBeDefined();
    expect(persisted.state).not.toHaveProperty('citedPassage');
    expect(persisted.state).not.toHaveProperty('previewFile');
  });

  it('clears the anchor on a session switch even when no preview is open', () => {
    // The regression this pins: the clear used to be nested inside an `if (previewFile)`, but a
    // chip click writes the anchor synchronously without opening a preview, so it survived.
    setSessionLayout({ citedPassage: anchor });
    expect(useSessionLayout.getState().previewFile).toBeNull();

    clearSessionScopedViewerState();

    expect(useSessionLayout.getState().citedPassage).toBeNull();
  });

  it('clears both the preview and the anchor together', () => {
    setSessionLayout({ previewFile, citedPassage: anchor });

    clearSessionScopedViewerState();

    expect(useSessionLayout.getState().previewFile).toBeNull();
    expect(useSessionLayout.getState().citedPassage).toBeNull();
  });

  it('leaves the store untouched when neither is set', () => {
    const before = useSessionLayout.getState();

    clearSessionScopedViewerState();

    expect(useSessionLayout.getState()).toBe(before);
  });
});
