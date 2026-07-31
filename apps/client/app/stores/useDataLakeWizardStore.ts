import { create } from 'zustand';
import { isReservedTagPrefix } from '@bike4mind/common';
import type { TaxonomyStatus } from '@bike4mind/common';
import type { FolderTreeNode, WizardFile } from '../utils/folderTreeParser';
import { slugifyDataLakeName } from '../hooks/data/dataLakeSlug';
import {
  parseFilesToTree,
  getAllFiles,
  toggleFolderExclusion,
  reapplyExclusions,
  DEFAULT_EXCLUDED_PATTERNS,
} from '../utils/folderTreeParser';

// ── Types ───────────────────────────────────────────────────────────────────

export type WizardStep = 'source' | 'preview' | 'config' | 'upload';

/** The two tabs of the Data Lakes management panel: own lakes vs. the public discover catalog. */
export type ManagerTab = 'mine' | 'discover';

/**
 * Which of the two optional steps/behaviors the user opted into on the source step.
 * `preview` splices a step into the wizard; `taxonomy` no longer does - it opts the
 * batch into a background AI tag-suggestion job that runs AFTER upload completes, reviewed
 * later from the Data Lakes list rather than blocking the wizard. Both default off, so the
 * minimal create path is name + files -> config -> upload.
 */
export interface OptionalSteps {
  preview: boolean;
  taxonomy: boolean;
}

export interface DataLakeFormValues {
  name: string;
  description: string;
  tagPrefix: string;
  requiredUserTag: string;
  /** Namespaced entitlement key (e.g. "product:pro") gating this lake; blank means no entitlement gate. */
  requiredEntitlement: string;
  conflictResolution: 'skip' | 'update' | 'duplicate';
}

/**
 * Which failure mode produced an error status, so the UI can show a message and
 * hint that actually match the cause (a config/validation problem vs a network or
 * upload problem) instead of one generic "check your Name and Tag Prefix" hint.
 */
export type UploadErrorKind = 'validation' | 'network' | 'upload' | 'server' | 'unknown';

export interface UploadProgress {
  totalFiles: number;
  uploadedFiles: number;
  chunkedFiles: number;
  vectorizedFiles: number;
  failedFiles: number;
  failedFileNames: string[];
  status: 'idle' | 'uploading' | 'complete' | 'error';
  /** Always a human-friendly, translated message - never raw zod/validator text. */
  errorMessage?: string;
  errorKind?: UploadErrorKind;
  currentBatchId?: string;
  /**
   * Background AI-tag suggestion phase, pushed over the same batch-progress
   * WebSocket channel as chunked/vectorized. Undefined until the first message naming it
   * arrives (enqueueing happens async, right after upload - not necessarily before this
   * step renders), so the UI treats "unset" the same as "still starting up" while
   * optionalSteps.taxonomy is true.
   */
  taxonomyStatus?: TaxonomyStatus;
}

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONAL_STEPS: OptionalSteps = {
  preview: false,
  taxonomy: false,
};

const DEFAULT_CONFIG: DataLakeFormValues = {
  name: '',
  description: '',
  tagPrefix: '',
  requiredUserTag: '',
  requiredEntitlement: '',
  conflictResolution: 'skip',
};

const DEFAULT_UPLOAD_PROGRESS: UploadProgress = {
  totalFiles: 0,
  uploadedFiles: 0,
  chunkedFiles: 0,
  vectorizedFiles: 0,
  failedFiles: 0,
  failedFileNames: [],
  status: 'idle',
};

/**
 * A clean create-session's worth of state (everything except isOpen). Shared by openWizard,
 * openWizardForLake, and resetWizard so opening the wizard can never inherit a prior session's
 * files or config.
 */
const freshSession = () => ({
  step: 'source' as WizardStep,
  folderTree: null,
  allFiles: [] as WizardFile[],
  excludedPatterns: [...DEFAULT_EXCLUDED_PATTERNS],
  optionalSteps: { ...DEFAULT_OPTIONAL_STEPS },
  config: { ...DEFAULT_CONFIG },
  autoDerivedTagPrefix: '',
  duplicateCheckResults: null,
  uploadProgress: { ...DEFAULT_UPLOAD_PROGRESS },
  hashingProgress: { total: 0, completed: 0, status: 'idle' as const },
  targetLake: null as WizardTargetLake | null,
});

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * When set, the wizard runs in "append" mode: it uploads into this existing lake
 * instead of creating a new one (skips lake creation, and locks the Config fields
 * to the existing lake's values). AI tag suggestion is never offered in this mode -
 * the target lake's tag vocabulary already exists.
 */
export interface WizardTargetLake {
  id: string;
  slug: string;
  name: string;
  fileTagPrefix: string;
  requiredUserTag?: string;
  requiredEntitlement?: string;
}

interface DataLakeWizardStore {
  // State
  isOpen: boolean;
  step: WizardStep;
  folderTree: FolderTreeNode | null;
  allFiles: WizardFile[];
  excludedPatterns: string[];
  /** Opt-ins: `preview` (a wizard step) and `taxonomy` (a post-upload background job). */
  optionalSteps: OptionalSteps;
  config: DataLakeFormValues;
  /**
   * The last prefix deriveTagPrefixFromName produced, so a rename can re-derive over it while a
   * hand-edited prefix stays untouched. Never read outside that action.
   */
  autoDerivedTagPrefix: string;
  duplicateCheckResults: { duplicateCount: number; checkedAt: number } | null;
  uploadProgress: UploadProgress;
  hashingProgress: { total: number; completed: number; status: 'idle' | 'hashing' | 'done' };
  /** Non-null when appending to an existing lake (vs creating a new one). */
  targetLake: WizardTargetLake | null;
  /** Drives the Data Lakes management panel (list + lifecycle), distinct from the wizard. */
  isManagerOpen: boolean;
  /** Which manager tab to show on open: the caller's own lakes, or the public discover catalog. */
  managerTab: ManagerTab;

  // Navigation
  openWizard: () => void;
  openWizardForLake: (lake: WizardTargetLake) => void;
  closeWizard: () => void;
  openManager: (tab?: ManagerTab) => void;
  closeManager: () => void;
  setStep: (step: WizardStep) => void;

  // Source step
  setFiles: (files: File[]) => void;
  setOptionalStep: (key: keyof OptionalSteps, enabled: boolean) => void;

  // Preview step
  toggleFolderExclusion: (path: string) => void;
  setExcludedPatterns: (patterns: string[]) => void;

  // Tag prefix (owned by the Config step; the taxonomy step's competing home was removed)
  setTagPrefix: (prefix: string) => void;
  deriveTagPrefixFromName: () => void;

  // Config step
  setConfig: (config: Partial<DataLakeFormValues>) => void;
  setDuplicateResults: (results: { duplicateCount: number; checkedAt: number }) => void;

  // Hashing / dedup
  updateHashingProgress: (
    progress: Partial<{ total: number; completed: number; status: 'idle' | 'hashing' | 'done' }>
  ) => void;
  setFileHash: (relativePath: string, hash: string) => void;
  markDuplicates: (duplicates: { hash: string; fileId: string }[]) => void;

  // Upload step
  updateUploadProgress: (progress: Partial<UploadProgress>) => void;

  // Reset
  resetWizard: () => void;
}

export const useDataLakeWizardStore = create<DataLakeWizardStore>((set, get) => ({
  // ── Initial State ───────────────────────────────────────────────────────
  isOpen: false,
  step: 'source',
  folderTree: null,
  allFiles: [],
  excludedPatterns: [...DEFAULT_EXCLUDED_PATTERNS],
  optionalSteps: { ...DEFAULT_OPTIONAL_STEPS },
  config: { ...DEFAULT_CONFIG },
  autoDerivedTagPrefix: '',
  duplicateCheckResults: null,
  uploadProgress: { ...DEFAULT_UPLOAD_PROGRESS },
  hashingProgress: { total: 0, completed: 0, status: 'idle' as const },
  targetLake: null,
  isManagerOpen: false,
  managerTab: 'mine',

  // ── Navigation ──────────────────────────────────────────────────────────

  openWizard: () => set({ isOpen: true, ...freshSession() }),

  // Management panel (list lakes, add files, lifecycle). Its internal "Create"
  // button calls openWizard, which stacks the wizard on top and returns here on close.
  // An optional tab lets callers deep-link straight to the public discover catalog.
  openManager: (tab: ManagerTab = 'mine') => set({ isManagerOpen: true, managerTab: tab }),
  closeManager: () => set({ isManagerOpen: false }),

  // Append mode: upload into an existing lake. Preseeds config from the lake so
  // the (locked) Config step shows the right values.
  openWizardForLake: lake =>
    set({
      isOpen: true,
      ...freshSession(),
      targetLake: lake,
      config: {
        ...DEFAULT_CONFIG,
        name: lake.name,
        tagPrefix: lake.fileTagPrefix,
        requiredUserTag: lake.requiredUserTag ?? '',
        requiredEntitlement: lake.requiredEntitlement ?? '',
      },
    }),

  closeWizard: () => set({ isOpen: false }),

  setStep: step => set({ step }),

  // ── Source Step ─────────────────────────────────────────────────────────

  setFiles: files => {
    const { excludedPatterns } = get();
    const tree = parseFilesToTree(files, excludedPatterns);
    const allFiles = getAllFiles(tree);
    set({ folderTree: tree, allFiles });
  },

  setOptionalStep: (key, enabled) => set(state => ({ optionalSteps: { ...state.optionalSteps, [key]: enabled } })),

  // ── Preview Step ────────────────────────────────────────────────────────

  toggleFolderExclusion: path => {
    const { folderTree, excludedPatterns } = get();
    if (!folderTree) return;
    // Patterns go in so the toggled subtree's files are re-evaluated against them: excluding
    // then re-including a folder must not resurrect the junk files inside it.
    const updated = toggleFolderExclusion(folderTree, path, excludedPatterns);
    set({ folderTree: updated, allFiles: getAllFiles(updated) });
  },

  setExcludedPatterns: patterns => {
    const { folderTree } = get();
    if (!folderTree) {
      set({ excludedPatterns: patterns });
      return;
    }
    const updated = reapplyExclusions(folderTree, patterns);
    set({ excludedPatterns: patterns, folderTree: updated, allFiles: getAllFiles(updated) });
  },

  // ── Tag Prefix ──────────────────────────────────────────────────────────

  // The Tag Prefix's single editable home is the Config step (the taxonomy step's former
  // competing one was removed - AI tag suggestion now runs post-upload and never touches the
  // prefix). Clears the auto-derive provenance marker: once the user types a prefix, it's
  // theirs, and a later rename must not silently overwrite it.
  setTagPrefix: prefix =>
    set(state => ({
      config: { ...state.config, tagPrefix: prefix },
      autoDerivedTagPrefix: '',
    })),

  /**
   * Derive the tag prefix from the lake name. Re-derives over a prefix this last produced (so
   * a rename can't leave the prefix quoting an abandoned name); a prefix the user typed by
   * hand is never touched. Called when leaving the source step (see DataLakeWizardModal).
   */
  deriveTagPrefixFromName: () =>
    set(state => {
      const current = state.config.tagPrefix.trim();
      const isOurs = !current || current === state.autoDerivedTagPrefix;
      if (!isOurs) return state;
      const prefix = `${slugifyDataLakeName(state.config.name)}:`;
      // A lake named "Datalake" derives the reserved membership namespace, which the server
      // rejects and Start Upload gates on - leaving the user blocked over a value they never
      // typed. Leave the field for them to fill instead of seeding one that cannot be used.
      if (isReservedTagPrefix(prefix)) return state;
      return {
        autoDerivedTagPrefix: prefix,
        config: { ...state.config, tagPrefix: prefix },
      };
    }),

  // ── Config Step ─────────────────────────────────────────────────────────

  setConfig: config => set(state => ({ config: { ...state.config, ...config } })),

  setDuplicateResults: results => set({ duplicateCheckResults: results }),

  // ── Hashing / Dedup ───────────────────────────────────────────────────

  updateHashingProgress: progress =>
    set(state => ({
      hashingProgress: { ...state.hashingProgress, ...progress },
    })),

  setFileHash: (relativePath, hash) =>
    set(state => ({
      allFiles: state.allFiles.map(f => (f.relativePath === relativePath ? { ...f, contentHash: hash } : f)),
    })),

  markDuplicates: duplicates =>
    set(state => {
      const hashToFileId = new Map(duplicates.map(d => [d.hash, d.fileId]));
      return {
        allFiles: state.allFiles.map(f => {
          if (f.contentHash && hashToFileId.has(f.contentHash)) {
            return { ...f, isDuplicate: true, existingFileId: hashToFileId.get(f.contentHash) };
          }
          return f;
        }),
        duplicateCheckResults: {
          duplicateCount: duplicates.length,
          checkedAt: Date.now(),
        },
      };
    }),

  // ── Upload Step ─────────────────────────────────────────────────────────

  updateUploadProgress: progress =>
    set(state => ({
      uploadProgress: { ...state.uploadProgress, ...progress },
    })),

  // ── Reset ───────────────────────────────────────────────────────────────

  resetWizard: () => set({ isOpen: false, ...freshSession() }),
}));
