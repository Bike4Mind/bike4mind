import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  type MermaidArtifact,
  type ReactArtifact,
  type HtmlArtifact,
  type SvgArtifact,
  type RechartsArtifact,
  type ChessArtifact,
  type LatticeArtifact,
  type PythonArtifact,
  QuestMasterData,
  type IFabFileDocument,
} from '@bike4mind/common';

export type DefaultLayoutType =
  | 'horizontal'
  | 'vertical'
  | 'pip'
  | 'noAI'
  | 'hide'
  | 'floatingChat'
  | 'dockRight'
  | 'dockBottom';

export interface CodeArtifactData {
  title: string;
  description: string;
  language: string;
  code: string;
  lineCount: number;
}

export interface ArtifactData {
  type: 'questmaster' | 'code' | 'mermaid' | 'react' | 'html' | 'svg' | 'recharts' | 'chess' | 'lattice' | 'python';
  content:
    | QuestMasterData
    | CodeArtifactData
    | string
    | MermaidArtifact
    | ReactArtifact
    | HtmlArtifact
    | SvgArtifact
    | RechartsArtifact
    | ChessArtifact
    | LatticeArtifact
    | PythonArtifact;
  mimeType: string;
  id: string;
}

export interface PendingMessageFile {
  fabFile: IFabFileDocument;
  uploadProgress: number;
  // 'scanning'/'blocked' cover an uploaded image pending/failing the async content-moderation
  // scan before it's safe to serve (see fabFile.moderationStatus + isImageServeable).
  status: 'uploading' | 'complete' | 'error' | 'scanning' | 'blocked';
}

interface SessionLayoutControlState {
  layout: DefaultLayoutType;
  artifactData?: ArtifactData;
  recentArtifacts: ArtifactData[]; // Collection of recently clicked artifacts
  selectedArtifactId?: string;
  // Selected version number for viewing, keyed by artifact id. Per-artifact so a version
  // chosen for artifact A never bleeds into the preview opened for artifact B in the same
  // session. Read/write via getSelectedArtifactVersion/setSelectedArtifactVersion.
  selectedArtifactVersions?: Record<string, number>;
  knowledgeViewerWidth?: number; // Width percentage for KnowledgeViewer (0-100)
  maxRecentArtifacts: number; // Maximum number of artifacts to keep in cache
  pendingMessageFiles: PendingMessageFile[]; // Files being uploaded for messages
  // Buffers `image_moderation_status` websocket events keyed by fabFileId when
  // they arrive before the upload's temp-id -> real-FabFile-id swap resolves (see
  // SessionFilePond's upload `.then`), so the composer thumbnail doesn't get stuck on
  // 'scanning' forever. Consumed (and cleared) via consumeBufferedModerationStatus once the
  // real id is known. Not persisted - a stale buffered event is meaningless across reloads.
  pendingModerationEvents: Record<string, { moderationStatus: 'clean' | 'blocked'; fileUrl?: string }>;
  // Floating chat window state
  floatingChatPosition: { x: number; y: number };
  floatingChatSize: { width: number; height: number };
  floatingChatMinimized: boolean;
  previousLayout?: DefaultLayoutType; // Track layout before entering floating mode for close behavior
  // Docked chat panel sizing (percentage)
  dockChatWidth: number; // Width % for dockRight mode (default 35)
  dockChatHeight: number; // Height % for dockBottom mode (default 40)
  // Optimistic first-message: holds the user's prompt while the new session is being
  // confirmed by the server. Cleared on session.created. Not persisted.
  pendingFirstMessage: string | null;
  // The client-generated tmpId used during optimistic pre-navigation. Read via
  // .getState() in session.created handler to avoid stale-ref migration bugs.
  // Not persisted.
  pendingOptimisticId: string | null;
}

const useSessionLayout = create<SessionLayoutControlState>()(
  persist(
    _set => ({
      layout: 'hide',
      knowledgeViewerWidth: 50, // Default to 50% width
      recentArtifacts: [],
      maxRecentArtifacts: 10, // Default max cache size
      pendingMessageFiles: [],
      pendingModerationEvents: {},
      pendingFirstMessage: null,
      pendingOptimisticId: null,
      // Floating chat window defaults - centered with reasonable size
      floatingChatPosition: { x: -1, y: -1 }, // -1 indicates "center on first use"
      floatingChatSize: { width: 450, height: 600 },
      floatingChatMinimized: false,
      previousLayout: undefined,
      dockChatWidth: 35,
      dockChatHeight: 40,
    }),
    {
      name: 'layout-control',
      // Exclude recentArtifacts and pendingMessageFiles from persistence to prevent stale data
      partialize: state => ({
        layout: state.layout,
        artifactData: state.artifactData, // Keep for backward compatibility
        selectedArtifactId: state.selectedArtifactId,
        selectedArtifactVersions: state.selectedArtifactVersions,
        knowledgeViewerWidth: state.knowledgeViewerWidth,
        maxRecentArtifacts: state.maxRecentArtifacts,
        // Floating chat window position/size persisted for cross-session memory
        floatingChatPosition: state.floatingChatPosition,
        floatingChatSize: state.floatingChatSize,
        // floatingChatMinimized intentionally excluded - controlled at mount time
        // to avoid hydration race where persisted false overwrites auto-minimize on mobile
        // Docked chat panel sizing persisted for cross-session memory
        dockChatWidth: state.dockChatWidth,
        dockChatHeight: state.dockChatHeight,
        // recentArtifacts, pendingMessageFiles, pendingModerationEvents, and previousLayout
        // intentionally excluded
      }),
    }
  )
);

/**
 * Adds an artifact to the recent artifacts cache using LRU (Least Recently Used) strategy
 * @param artifact - The artifact to add
 * @returns Updated recentArtifacts array
 */
export const addArtifactToRecent = (artifact: ArtifactData): ArtifactData[] => {
  const state = useSessionLayout.getState();
  const { recentArtifacts, maxRecentArtifacts } = state;

  // Check if artifact already exists (by ID)
  const existingIndex = recentArtifacts.findIndex(a => a.id === artifact.id);

  if (existingIndex !== -1) {
    // Replace existing entry with the incoming artifact and move to front.
    // Using `existing` here would discard freshly-iterated content,
    // leaving the Knowledge Base viewer showing stale versions.
    const updated = [...recentArtifacts];
    updated.splice(existingIndex, 1);
    updated.unshift(artifact);
    return updated;
  }

  // Add new artifact to front
  const updated = [artifact, ...recentArtifacts];

  // Trim to maxRecentArtifacts (LRU: remove least recently used)
  if (updated.length > maxRecentArtifacts) {
    updated.splice(maxRecentArtifacts);
  }

  return updated;
};

export const setSessionLayout = (
  newStateOrUpdater:
    | Partial<SessionLayoutControlState>
    | ((prev: SessionLayoutControlState) => Partial<SessionLayoutControlState>)
) => {
  const currentState = useSessionLayout.getState();

  // If it's a function, call it with current state
  const newState = typeof newStateOrUpdater === 'function' ? newStateOrUpdater(currentState) : newStateOrUpdater;

  // If artifactData is provided, add to recentArtifacts
  if (newState.artifactData) {
    const updatedRecent = addArtifactToRecent(newState.artifactData);

    useSessionLayout.setState({
      ...newState,
      recentArtifacts: updatedRecent,
      selectedArtifactId: newState.artifactData.id, // Auto-set for tab switching
    });
    return;
  }

  // If the new state doesn't explicitly include artifactData but has a layout change,
  // and the current state has artifactData, preserve it
  if (
    newState.layout &&
    !newState.artifactData &&
    currentState.artifactData &&
    // Only preserve if we're not explicitly hiding the panel and if layout is changed
    newState.layout !== 'hide' &&
    newState.layout !== currentState.layout
  ) {
    useSessionLayout.setState({
      ...newState,
      artifactData: currentState.artifactData,
      selectedArtifactId: currentState.selectedArtifactId,
    });
  } else {
    // If artifactData is provided or we're hiding the panel, update normally
    useSessionLayout.setState(newState);
  }
};

/**
 * Returns the version selected for a specific artifact, or undefined if none was chosen
 * (in which case callers should fall back to the artifact's own latest version).
 *
 * Keyed per-artifact so the selection for one artifact never resolves for another.
 */
export const getSelectedArtifactVersion = (artifactId: string): number | undefined =>
  useSessionLayout.getState().selectedArtifactVersions?.[artifactId];

/**
 * Sets (or clears) the selected version for a specific artifact.
 * Pass `undefined` to clear the selection so the viewer reverts to the artifact's latest
 * version (e.g. when opening it fresh via "Open in preview").
 *
 * Updates are immutable and scoped to the given artifact id, leaving other artifacts'
 * selections untouched.
 */
export const setSelectedArtifactVersion = (artifactId: string, version: number | undefined) => {
  const current = useSessionLayout.getState().selectedArtifactVersions ?? {};
  const next = { ...current };
  if (version === undefined) {
    delete next[artifactId];
  } else {
    next[artifactId] = version;
  }
  useSessionLayout.setState({ selectedArtifactVersions: next });
};

/**
 * Clears recent artifacts cache
 * Call this when starting a new conversation
 */
export const clearRecentArtifacts = () => {
  useSessionLayout.setState({
    recentArtifacts: [],
    artifactData: undefined,
    selectedArtifactId: undefined,
    // Version selections are keyed by (conversation-scoped) artifact ids, so reset them
    // alongside the recent-artifacts cache to bound growth and avoid stale entries
    selectedArtifactVersions: {},
  });
};

/**
 * Updates pending message files state
 * Supports both direct array updates and updater functions for safe concurrent updates
 *
 * @param filesOrUpdater - Either a new array of pending files or an updater function
 *
 * @example
 * // Direct update
 * setPendingMessageFiles([{ fabFile, uploadProgress: 0, status: 'uploading' }]);
 *
 * @example
 * // Updater function (safer for concurrent updates)
 * setPendingMessageFiles(prev => [...prev, newFile]);
 */
export const setPendingMessageFiles = (
  filesOrUpdater: PendingMessageFile[] | ((prev: PendingMessageFile[]) => PendingMessageFile[])
) => {
  const currentState = useSessionLayout.getState();
  const currentFiles = currentState.pendingMessageFiles || [];

  const newFiles = typeof filesOrUpdater === 'function' ? filesOrUpdater(currentFiles) : filesOrUpdater;

  useSessionLayout.setState({
    pendingMessageFiles: newFiles,
  });
};

/**
 * Pure reducer applying an `image_moderation_status` websocket event to a
 * `pendingMessageFiles` array: finds the item whose `fabFile.id` matches `fabFileId` and
 * flips it from `'scanning'` to either `'complete'` (clean) or `'blocked'`, updating the
 * embedded `fabFile.moderationStatus` too so `GetFileIcon`'s `isImageServeable` check picks
 * it up. A `'pending'` status (or no matching item) is a no-op, returning the input array
 * unchanged.
 *
 * A held image's `fabFile.fileUrl` is nulled by the serve-gate while scanning (only a
 * PUT-signed `presignedUrl` remains, which fails a GET), so on `'clean'` the caller should
 * re-fetch the fabFile to get a fresh GET-signed view URL and pass it as `fileUrl` - this
 * merges it onto `fabFile.fileUrl` (and stamps `fileUrlExpireAt`) so `GetFileIcon` has a
 * real image to render instead of a broken/generic icon. When `fileUrl` is omitted (e.g.
 * the re-fetch failed, or the `'blocked'` case) the item's `fabFile.fileUrl` is left as-is.
 *
 * Extracted as a pure function (rather than inlined in the subscriber callback) so the
 * scan-result -> composer-thumbnail transition can be unit tested without mounting a
 * websocket connection.
 */
export const patchPendingMessageFileModerationStatus = (
  files: PendingMessageFile[],
  fabFileId: string,
  moderationStatus: 'pending' | 'clean' | 'blocked',
  fileUrl?: string
): PendingMessageFile[] => {
  if (moderationStatus === 'pending') return files;

  return files.map(item => {
    if (item.fabFile.id !== fabFileId) return item;

    return {
      ...item,
      status: moderationStatus === 'clean' ? 'complete' : 'blocked',
      fabFile: {
        ...item.fabFile,
        moderationStatus,
        ...(fileUrl ? { fileUrl, fileUrlExpireAt: new Date(Date.now() + 3600 * 1000) } : {}),
      },
    };
  });
};

/**
 * True when the composer must hold the Send button disabled because a pending message file
 * is still uploading or being content-moderation-scanned. `'blocked'` is
 * intentionally excluded - a blocked file is terminal (it will never become sendable) and
 * must stay individually removable rather than permanently trapping the composer.
 *
 * Extracted as a pure predicate so the send-disable condition can be unit tested without
 * mounting SessionBottom/SessionToolbar.
 */
export const hasBlockingPendingFiles = (pendingMessageFiles: PendingMessageFile[]): boolean =>
  pendingMessageFiles.some(pf => pf.status === 'uploading' || pf.status === 'scanning');

/**
 * Splits a message's pending files into the ids that are safe to attach to the outgoing
 * message and a flag for whether any file was excluded because it's `'blocked'`.
 * `'scanning'` files are also excluded (the scan hasn't cleared yet) but don't set
 * `hadBlocked` - the send button is already held disabled for those via
 * `hasBlockingPendingFiles`, so no extra user-facing signal is needed; `'blocked'` is the
 * case a user can otherwise (correctly) dismiss and try to send past.
 *
 * Extracted as a pure function so useSendMessage's attachment-id collection can be unit
 * tested without mounting the composer.
 */
export const getSendableMessageFileIds = (
  pendingMessageFiles: PendingMessageFile[]
): { ids: string[]; hadBlocked: boolean } => {
  const ids: string[] = [];
  let hadBlocked = false;

  for (const item of pendingMessageFiles) {
    if (item.status === 'blocked') {
      hadBlocked = true;
      continue;
    }
    if (item.status === 'scanning') continue;
    ids.push(item.fabFile.id);
  }

  return { ids, hadBlocked };
};

/**
 * Records an `image_moderation_status` websocket event for a pending message file.
 * If the file is already present in `pendingMessageFiles` under its real
 * FabFile id, the status is applied immediately via `patchPendingMessageFileModerationStatus`.
 *
 * Otherwise the event is buffered by `fabFileId` - this covers the race where the websocket
 * event arrives before the upload's temp-id -> real-id swap (see SessionFilePond), which
 * would otherwise make the patch a silent no-op and strand the item on the 'scanning'
 * placeholder forever. The buffered event is replayed via `consumeBufferedModerationStatus`
 * once the real id is known.
 */
export const recordModerationStatus = (
  fabFileId: string,
  moderationStatus: 'pending' | 'clean' | 'blocked',
  fileUrl?: string
): void => {
  if (moderationStatus === 'pending') return;

  const { pendingMessageFiles, pendingModerationEvents } = useSessionLayout.getState();
  const hasKnownId = pendingMessageFiles.some(item => item.fabFile.id === fabFileId);

  if (hasKnownId) {
    useSessionLayout.setState({
      pendingMessageFiles: patchPendingMessageFileModerationStatus(
        pendingMessageFiles,
        fabFileId,
        moderationStatus,
        fileUrl
      ),
    });
    return;
  }

  useSessionLayout.setState({
    pendingModerationEvents: {
      ...pendingModerationEvents,
      [fabFileId]: { moderationStatus, fileUrl },
    },
  });
};

/**
 * Reconciles a buffered `image_moderation_status` event (see `recordModerationStatus`) once
 * a pending message file's real FabFile id is known - i.e. right after SessionFilePond swaps
 * the upload's temp id for the server-issued fabFile. Returns the buffered event (and clears
 * it from the buffer) so the caller can apply it via `patchPendingMessageFileModerationStatus`
 * instead of defaulting the item to `'scanning'`. Returns `undefined` when nothing was
 * buffered for this id (the common case - no race occurred).
 */
export const consumeBufferedModerationStatus = (
  fabFileId: string
): { moderationStatus: 'clean' | 'blocked'; fileUrl?: string } | undefined => {
  const { pendingModerationEvents } = useSessionLayout.getState();
  const buffered = pendingModerationEvents[fabFileId];
  if (!buffered) return undefined;

  const next = { ...pendingModerationEvents };
  delete next[fabFileId];
  useSessionLayout.setState({ pendingModerationEvents: next });

  return buffered;
};

export default useSessionLayout;
