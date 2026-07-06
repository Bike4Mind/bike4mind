import { describe, it, expect, beforeEach } from 'vitest';
import useSessionLayout, {
  addArtifactToRecent,
  setSessionLayout,
  clearRecentArtifacts,
  getSelectedArtifactVersion,
  setSelectedArtifactVersion,
  patchPendingMessageFileModerationStatus,
  hasBlockingPendingFiles,
  getSendableMessageFileIds,
  recordModerationStatus,
  consumeBufferedModerationStatus,
  type ArtifactData,
  type PendingMessageFile,
} from '../useSessionLayout';
import type { IFabFileDocument } from '@bike4mind/common';

// Helper to create mock artifact
const createMockArtifact = (overrides: Partial<ArtifactData>): ArtifactData => ({
  type: 'code',
  content: {
    title: 'Test Code',
    description: 'Test description',
    language: 'javascript',
    code: 'console.log("test");',
    lineCount: 1,
  },
  mimeType: 'application/x-code',
  id: `artifact-${Date.now()}-${Math.random()}`,
  ...overrides,
});

describe('useSessionLayout - LRU Cache Functions', () => {
  beforeEach(() => {
    // Reset state before each test
    useSessionLayout.setState({
      layout: 'hide',
      recentArtifacts: [],
      maxRecentArtifacts: 10,
      selectedArtifactVersions: {},
    });
  });

  describe('addArtifactToRecent', () => {
    it('should add new artifact to front of array', () => {
      const artifact = createMockArtifact({ id: 'test-1' });
      const result = addArtifactToRecent(artifact);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('test-1');
    });

    it('should add multiple new artifacts to front', () => {
      const artifact1 = createMockArtifact({ id: 'test-1' });
      const artifact2 = createMockArtifact({ id: 'test-2' });

      let result = addArtifactToRecent(artifact1);
      useSessionLayout.setState({ recentArtifacts: result });

      result = addArtifactToRecent(artifact2);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('test-2'); // Most recent
      expect(result[1].id).toBe('test-1');
    });

    it('should move existing artifact to front (LRU behavior)', () => {
      // Setup: Add 3 artifacts
      const artifact1 = createMockArtifact({ id: 'test-1' });
      const artifact2 = createMockArtifact({ id: 'test-2' });
      const artifact3 = createMockArtifact({ id: 'test-3' });

      let result = addArtifactToRecent(artifact1);
      useSessionLayout.setState({ recentArtifacts: result });
      result = addArtifactToRecent(artifact2);
      useSessionLayout.setState({ recentArtifacts: result });
      result = addArtifactToRecent(artifact3);
      useSessionLayout.setState({ recentArtifacts: result });

      // Order should be: test-3, test-2, test-1
      expect(result[0].id).toBe('test-3');
      expect(result[1].id).toBe('test-2');
      expect(result[2].id).toBe('test-1');

      // Click test-1 again
      result = addArtifactToRecent(artifact1);

      // test-1 should move to front
      expect(result).toHaveLength(3); // Still 3 items
      expect(result[0].id).toBe('test-1'); // Moved to front
      expect(result[1].id).toBe('test-3');
      expect(result[2].id).toBe('test-2');
    });

    it('should evict oldest artifact when exceeding maxRecentArtifacts', () => {
      // Set max to 3
      useSessionLayout.setState({ maxRecentArtifacts: 3 });

      // Add 4 artifacts
      const artifact1 = createMockArtifact({ id: 'test-1' });
      const artifact2 = createMockArtifact({ id: 'test-2' });
      const artifact3 = createMockArtifact({ id: 'test-3' });
      const artifact4 = createMockArtifact({ id: 'test-4' });

      let result = addArtifactToRecent(artifact1);
      useSessionLayout.setState({ recentArtifacts: result });
      result = addArtifactToRecent(artifact2);
      useSessionLayout.setState({ recentArtifacts: result });
      result = addArtifactToRecent(artifact3);
      useSessionLayout.setState({ recentArtifacts: result });
      result = addArtifactToRecent(artifact4);

      // Should only keep 3 artifacts
      expect(result).toHaveLength(3);
      expect(result.map(a => a.id)).toEqual(['test-4', 'test-3', 'test-2']);
      // test-1 should be evicted (oldest)
    });

    it('should handle max limit of 1 correctly', () => {
      useSessionLayout.setState({ maxRecentArtifacts: 1 });

      const artifact1 = createMockArtifact({ id: 'test-1' });
      const artifact2 = createMockArtifact({ id: 'test-2' });

      let result = addArtifactToRecent(artifact1);
      useSessionLayout.setState({ recentArtifacts: result });
      result = addArtifactToRecent(artifact2);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('test-2');
    });
  });

  describe('clearRecentArtifacts', () => {
    it('should clear all artifacts', () => {
      // Setup: Add some artifacts
      const artifact1 = createMockArtifact({ id: 'test-1' });
      const artifact2 = createMockArtifact({ id: 'test-2' });

      let result = addArtifactToRecent(artifact1);
      useSessionLayout.setState({ recentArtifacts: result });
      result = addArtifactToRecent(artifact2);
      useSessionLayout.setState({ recentArtifacts: result });
      setSelectedArtifactVersion('test-1', 3);

      expect(useSessionLayout.getState().recentArtifacts).toHaveLength(2);

      // Clear
      clearRecentArtifacts();

      const state = useSessionLayout.getState();
      expect(state.recentArtifacts).toHaveLength(0);
      expect(state.artifactData).toBeUndefined();
      expect(state.selectedArtifactId).toBeUndefined();
      // Per-artifact version selections are conversation-scoped and reset too
      expect(getSelectedArtifactVersion('test-1')).toBeUndefined();
    });

    it('should not error when clearing already empty state', () => {
      clearRecentArtifacts();
      const state = useSessionLayout.getState();
      expect(state.recentArtifacts).toHaveLength(0);
    });
  });

  describe('setSessionLayout with artifactData', () => {
    it('should add artifact to recentArtifacts when artifactData provided', () => {
      const artifact = createMockArtifact({ id: 'test-1' });

      setSessionLayout({
        layout: 'vertical',
        artifactData: artifact,
      });

      const state = useSessionLayout.getState();
      expect(state.layout).toBe('vertical');
      expect(state.recentArtifacts).toHaveLength(1);
      expect(state.recentArtifacts[0].id).toBe('test-1');
    });

    it('should auto-set selectedArtifactId when artifactData provided', () => {
      const artifact = createMockArtifact({ id: 'test-1' });

      setSessionLayout({
        layout: 'vertical',
        artifactData: artifact,
      });

      const state = useSessionLayout.getState();
      expect(state.selectedArtifactId).toBe('test-1');
    });

    it('should handle multiple artifacts correctly', () => {
      const artifact1 = createMockArtifact({ id: 'test-1' });
      const artifact2 = createMockArtifact({ id: 'test-2' });

      setSessionLayout({
        layout: 'vertical',
        artifactData: artifact1,
      });

      setSessionLayout({
        layout: 'vertical',
        artifactData: artifact2,
      });

      const state = useSessionLayout.getState();
      expect(state.recentArtifacts).toHaveLength(2);
      expect(state.recentArtifacts[0].id).toBe('test-2'); // Most recent
      expect(state.recentArtifacts[1].id).toBe('test-1');
      expect(state.selectedArtifactId).toBe('test-2');
    });

    it('should use LRU behavior when adding duplicate', () => {
      const artifact1 = createMockArtifact({ id: 'test-1' });
      const artifact2 = createMockArtifact({ id: 'test-2' });

      setSessionLayout({ layout: 'vertical', artifactData: artifact1 });
      setSessionLayout({ layout: 'vertical', artifactData: artifact2 });
      setSessionLayout({ layout: 'vertical', artifactData: artifact1 }); // Duplicate

      const state = useSessionLayout.getState();
      expect(state.recentArtifacts).toHaveLength(2); // Still 2
      expect(state.recentArtifacts[0].id).toBe('test-1'); // Moved to front
      expect(state.recentArtifacts[1].id).toBe('test-2');
    });
  });

  describe('setSessionLayout layout changes', () => {
    it('should update layout without artifactData', () => {
      setSessionLayout({ layout: 'horizontal' });
      expect(useSessionLayout.getState().layout).toBe('horizontal');
    });

    it('should preserve artifactData when changing layout', () => {
      const artifact = createMockArtifact({ id: 'test-1' });

      setSessionLayout({
        layout: 'vertical',
        artifactData: artifact,
      });

      setSessionLayout({ layout: 'horizontal' });

      const state = useSessionLayout.getState();
      expect(state.layout).toBe('horizontal');
      expect(state.artifactData?.id).toBe('test-1'); // Preserved
    });

    it('should not hide panel if artifactData exists', () => {
      const artifact = createMockArtifact({ id: 'test-1' });

      setSessionLayout({
        layout: 'vertical',
        artifactData: artifact,
      });

      // Try to change to hide while artifact exists
      setSessionLayout({ layout: 'hide' });

      // Should still hide (explicit hide request)
      expect(useSessionLayout.getState().layout).toBe('hide');
    });
  });

  describe('LRU cache edge cases', () => {
    it('should handle artifacts with same ID correctly', () => {
      const artifact = createMockArtifact({ id: 'test-1' });

      let result = addArtifactToRecent(artifact);
      useSessionLayout.setState({ recentArtifacts: result });
      result = addArtifactToRecent(artifact);
      useSessionLayout.setState({ recentArtifacts: result });
      result = addArtifactToRecent(artifact);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('test-1');
    });

    // Regression guard: when an artifact with the same ID is
    // re-added, the NEW artifact's content must replace the cached one.
    // A prior bug re-inserted the existing cached entry, leaving KB viewers
    // showing stale content after a user iterated on an artifact.
    it('should replace content when re-adding artifact with same ID', () => {
      const artifact1 = createMockArtifact({
        id: 'test-1',
        content: {
          title: 'Old Title',
          description: 'Old description',
          language: 'javascript',
          code: 'console.log("old");',
          lineCount: 1,
        },
      });
      let result = addArtifactToRecent(artifact1);
      useSessionLayout.setState({ recentArtifacts: result });

      const artifact2 = createMockArtifact({
        id: 'test-1',
        content: {
          title: 'New Title',
          description: 'New description',
          language: 'javascript',
          code: 'console.log("new");',
          lineCount: 1,
        },
      });
      result = addArtifactToRecent(artifact2);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('test-1');
      expect(result[0].content).toEqual(artifact2.content);
    });

    it('should maintain order when capacity is reached', () => {
      useSessionLayout.setState({ maxRecentArtifacts: 2 });

      const artifact1 = createMockArtifact({ id: 'test-1' });
      const artifact2 = createMockArtifact({ id: 'test-2' });
      const artifact3 = createMockArtifact({ id: 'test-3' });

      let result = addArtifactToRecent(artifact1);
      useSessionLayout.setState({ recentArtifacts: result });
      result = addArtifactToRecent(artifact2);
      useSessionLayout.setState({ recentArtifacts: result });
      result = addArtifactToRecent(artifact3);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('test-3');
      expect(result[1].id).toBe('test-2');
    });
  });

  // Regression guard: the version selected for one artifact must not bleed into
  // the version resolved for any other artifact in the same session. Selections are keyed
  // per-artifact-id via get/setSelectedArtifactVersion rather than a single shared scalar.
  describe('per-artifact version selection', () => {
    it('returns undefined for an artifact with no selection (falls back to latest)', () => {
      expect(getSelectedArtifactVersion('artifact-A')).toBeUndefined();
    });

    it('stores and retrieves a version keyed by artifact id', () => {
      setSelectedArtifactVersion('artifact-A', 5);
      expect(getSelectedArtifactVersion('artifact-A')).toBe(5);
    });

    it('does not let one artifact’s selection bleed into another', () => {
      // The exact scenario: pick a non-latest version of artifact A...
      setSelectedArtifactVersion('artifact-A', 5);
      // ...then open artifact B, which has its own (none -> latest) selection.
      expect(getSelectedArtifactVersion('artifact-B')).toBeUndefined();
      // A's selection is untouched.
      expect(getSelectedArtifactVersion('artifact-A')).toBe(5);
    });

    it('keeps independent selections for multiple artifacts at once', () => {
      setSelectedArtifactVersion('artifact-A', 2);
      setSelectedArtifactVersion('artifact-B', 7);
      setSelectedArtifactVersion('artifact-C', 1);

      expect(getSelectedArtifactVersion('artifact-A')).toBe(2);
      expect(getSelectedArtifactVersion('artifact-B')).toBe(7);
      expect(getSelectedArtifactVersion('artifact-C')).toBe(1);
    });

    it('clears only the targeted artifact when set to undefined (Open in preview semantics)', () => {
      setSelectedArtifactVersion('artifact-A', 3);
      setSelectedArtifactVersion('artifact-B', 9);

      // "Open in preview" on B clears B's selection so it opens at its latest version...
      setSelectedArtifactVersion('artifact-B', undefined);

      expect(getSelectedArtifactVersion('artifact-B')).toBeUndefined();
      // ...without disturbing A's selection.
      expect(getSelectedArtifactVersion('artifact-A')).toBe(3);
    });

    it('overwrites the same artifact’s selection without affecting siblings', () => {
      setSelectedArtifactVersion('artifact-A', 1);
      setSelectedArtifactVersion('artifact-B', 4);
      setSelectedArtifactVersion('artifact-A', 6);

      expect(getSelectedArtifactVersion('artifact-A')).toBe(6);
      expect(getSelectedArtifactVersion('artifact-B')).toBe(4);
    });

    it('isolates cross-viewer writes (e.g. Python viewer selection never resolves for a React artifact)', () => {
      // Python viewer selects v8 for its artifact...
      setSelectedArtifactVersion('python-artifact', 8);
      // ...a React artifact in the same session resolves its own (absent) selection.
      expect(getSelectedArtifactVersion('react-artifact')).toBeUndefined();
    });
  });

  // The composer's live scan-status update. A `scanning` composer item flips to
  // `complete`/`blocked` when the image_moderation_status websocket event resolves.
  describe('patchPendingMessageFileModerationStatus', () => {
    const makePendingFile = (overrides: Partial<PendingMessageFile> = {}): PendingMessageFile => ({
      fabFile: { id: 'file-1', fileName: 'photo.png', mimeType: 'image/png' } as IFabFileDocument,
      uploadProgress: 100,
      status: 'scanning',
      ...overrides,
    });

    it("flips a 'scanning' item to 'complete' and stamps moderationStatus 'clean'", () => {
      const files = [makePendingFile()];

      const result = patchPendingMessageFileModerationStatus(files, 'file-1', 'clean');

      expect(result[0].status).toBe('complete');
      expect(result[0].fabFile.moderationStatus).toBe('clean');
    });

    it("merges a fresh fileUrl onto fabFile when 'clean' is patched with a fileUrl", () => {
      const files = [makePendingFile()];

      const result = patchPendingMessageFileModerationStatus(
        files,
        'file-1',
        'clean',
        'https://example.com/signed-get-url'
      );

      expect(result[0].status).toBe('complete');
      expect(result[0].fabFile.moderationStatus).toBe('clean');
      expect(result[0].fabFile.fileUrl).toBe('https://example.com/signed-get-url');
      expect(result[0].fabFile.fileUrlExpireAt).toBeInstanceOf(Date);
    });

    it("leaves fabFile.fileUrl untouched when 'clean' is patched without a fileUrl", () => {
      const files = [
        makePendingFile({
          fabFile: { id: 'file-1', fileName: 'photo.png', mimeType: 'image/png' } as IFabFileDocument,
        }),
      ];

      const result = patchPendingMessageFileModerationStatus(files, 'file-1', 'clean');

      expect(result[0].status).toBe('complete');
      expect(result[0].fabFile.fileUrl).toBeUndefined();
    });

    it("flips a 'scanning' item to 'blocked' and stamps moderationStatus 'blocked'", () => {
      const files = [makePendingFile()];

      const result = patchPendingMessageFileModerationStatus(files, 'file-1', 'blocked');

      expect(result[0].status).toBe('blocked');
      expect(result[0].fabFile.moderationStatus).toBe('blocked');
    });

    it('leaves the array unchanged for a pending status (no-op)', () => {
      const files = [makePendingFile()];

      const result = patchPendingMessageFileModerationStatus(files, 'file-1', 'pending');

      expect(result).toBe(files);
      expect(result[0].status).toBe('scanning');
    });

    it('leaves non-matching items untouched when patching a different fabFileId', () => {
      const files = [
        makePendingFile(),
        makePendingFile({ fabFile: { id: 'file-2', mimeType: 'image/png' } as IFabFileDocument }),
      ];

      const result = patchPendingMessageFileModerationStatus(files, 'file-2', 'clean');

      expect(result[0].status).toBe('scanning'); // file-1 untouched
      expect(result[1].status).toBe('complete'); // file-2 patched
    });

    it('is a no-op when no item matches the fabFileId', () => {
      const files = [makePendingFile()];

      const result = patchPendingMessageFileModerationStatus(files, 'does-not-exist', 'clean');

      expect(result[0]).toBe(files[0]);
      expect(result[0].status).toBe('scanning');
    });

    it('preserves other item fields (uploadProgress, fileName) when patching', () => {
      const files = [makePendingFile({ uploadProgress: 100 })];

      const result = patchPendingMessageFileModerationStatus(files, 'file-1', 'clean');

      expect(result[0].uploadProgress).toBe(100);
      expect(result[0].fabFile.fileName).toBe('photo.png');
    });
  });

  // The Send button must stay disabled while an image is being
  // scanned (not just while it's uploading), but a terminal 'blocked' file must stay
  // removable rather than permanently trapping the composer.
  describe('hasBlockingPendingFiles', () => {
    const makeFile = (status: PendingMessageFile['status']): PendingMessageFile => ({
      fabFile: { id: `file-${status}`, fileName: 'photo.png', mimeType: 'image/png' } as IFabFileDocument,
      uploadProgress: 100,
      status,
    });

    it('is true while a file is uploading', () => {
      expect(hasBlockingPendingFiles([makeFile('uploading')])).toBe(true);
    });

    it('is true while a file is scanning', () => {
      expect(hasBlockingPendingFiles([makeFile('scanning')])).toBe(true);
    });

    it('is false when a file is blocked (must remain removable, not trap the composer)', () => {
      expect(hasBlockingPendingFiles([makeFile('blocked')])).toBe(false);
    });

    it('is false when all files are complete', () => {
      expect(hasBlockingPendingFiles([makeFile('complete')])).toBe(false);
    });

    it('is false for an empty list', () => {
      expect(hasBlockingPendingFiles([])).toBe(false);
    });

    it('is true if any file among several is scanning', () => {
      expect(hasBlockingPendingFiles([makeFile('complete'), makeFile('scanning'), makeFile('blocked')])).toBe(true);
    });
  });

  // A held/blocked image must never ship as a message
  // attachment id - the server silently drops an unservable fabFile, leaving the LLM
  // with no attachment and the user with no signal.
  describe('getSendableMessageFileIds', () => {
    const makeFile = (id: string, status: PendingMessageFile['status']): PendingMessageFile => ({
      fabFile: { id, fileName: 'photo.png', mimeType: 'image/png' } as IFabFileDocument,
      uploadProgress: 100,
      status,
    });

    it('includes ids for complete files', () => {
      const { ids, hadBlocked } = getSendableMessageFileIds([makeFile('a', 'complete')]);
      expect(ids).toEqual(['a']);
      expect(hadBlocked).toBe(false);
    });

    it('excludes scanning files without flagging hadBlocked (send is already held via hasBlockingPendingFiles)', () => {
      const { ids, hadBlocked } = getSendableMessageFileIds([makeFile('a', 'complete'), makeFile('b', 'scanning')]);
      expect(ids).toEqual(['a']);
      expect(hadBlocked).toBe(false);
    });

    it('excludes blocked files and flags hadBlocked so the caller can surface a toast', () => {
      const { ids, hadBlocked } = getSendableMessageFileIds([makeFile('a', 'complete'), makeFile('b', 'blocked')]);
      expect(ids).toEqual(['a']);
      expect(hadBlocked).toBe(true);
    });

    it('excludes both scanning and blocked files from the same list', () => {
      const { ids, hadBlocked } = getSendableMessageFileIds([
        makeFile('a', 'complete'),
        makeFile('b', 'scanning'),
        makeFile('c', 'blocked'),
      ]);
      expect(ids).toEqual(['a']);
      expect(hadBlocked).toBe(true);
    });

    it('returns an empty id list and no flag for an empty input', () => {
      expect(getSendableMessageFileIds([])).toEqual({ ids: [], hadBlocked: false });
    });
  });

  // ws/id-swap race: the image_moderation_status websocket event
  // can arrive before SessionFilePond swaps the upload's temp id for the real FabFile id.
  // recordModerationStatus buffers the event by fabFileId in that case; consumeBufferedModerationStatus
  // replays it once the real id is known (see SessionFilePond's upload `.then`).
  describe('recordModerationStatus + consumeBufferedModerationStatus (id-swap race)', () => {
    beforeEach(() => {
      useSessionLayout.setState({ pendingMessageFiles: [], pendingModerationEvents: {} });
    });

    const makePendingFile = (id: string, status: PendingMessageFile['status'] = 'scanning'): PendingMessageFile => ({
      fabFile: { id, fileName: 'photo.png', mimeType: 'image/png' } as IFabFileDocument,
      uploadProgress: 100,
      status,
    });

    it('applies the status immediately when the fabFileId is already a known pending file', () => {
      useSessionLayout.setState({ pendingMessageFiles: [makePendingFile('file-1')] });

      recordModerationStatus('file-1', 'clean');

      expect(useSessionLayout.getState().pendingMessageFiles[0].status).toBe('complete');
      expect(useSessionLayout.getState().pendingModerationEvents['file-1']).toBeUndefined();
    });

    it('buffers the event when the fabFileId is not yet a known pending file (ws beats the id-swap)', () => {
      recordModerationStatus('file-2', 'blocked');

      expect(useSessionLayout.getState().pendingModerationEvents['file-2']).toEqual({
        moderationStatus: 'blocked',
        fileUrl: undefined,
      });
      // Nothing to patch yet - pendingMessageFiles is untouched.
      expect(useSessionLayout.getState().pendingMessageFiles).toEqual([]);
    });

    it('does not buffer a pending status', () => {
      recordModerationStatus('file-3', 'pending');
      expect(useSessionLayout.getState().pendingModerationEvents['file-3']).toBeUndefined();
    });

    it('consumeBufferedModerationStatus is a no-op and returns undefined when nothing was buffered', () => {
      expect(consumeBufferedModerationStatus('no-such-id')).toBeUndefined();
    });

    it('consumeBufferedModerationStatus returns and clears a buffered event', () => {
      recordModerationStatus('file-4', 'clean', 'https://example.com/fresh.png');

      const result = consumeBufferedModerationStatus('file-4');

      expect(result).toEqual({ moderationStatus: 'clean', fileUrl: 'https://example.com/fresh.png' });
      expect(useSessionLayout.getState().pendingModerationEvents['file-4']).toBeUndefined();
      // Consuming again returns undefined - it's cleared, not merely read.
      expect(consumeBufferedModerationStatus('file-4')).toBeUndefined();
    });

    it('replaying a buffered event via the reducer reconciles a freshly-known id (full id-swap race scenario)', () => {
      // The ws event arrives first, before the upload's temp-id -> real-id swap...
      recordModerationStatus('file-5', 'blocked');

      // ...then the upload resolves and SessionFilePond swaps in the real fabFile id,
      // landing the item on 'scanning' the way it normally would...
      const withRealFile = [makePendingFile('file-5', 'scanning')];

      // ...and reconciles by consuming the buffered event and replaying it through the
      // same pure reducer used by the live subscriber path.
      const buffered = consumeBufferedModerationStatus('file-5');
      expect(buffered).toBeDefined();
      const reconciled = patchPendingMessageFileModerationStatus(
        withRealFile,
        'file-5',
        buffered!.moderationStatus,
        buffered!.fileUrl
      );

      expect(reconciled[0].status).toBe('blocked');
      expect(reconciled[0].fabFile.moderationStatus).toBe('blocked');
    });
  });
});
