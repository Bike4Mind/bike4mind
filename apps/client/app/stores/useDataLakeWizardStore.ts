import { create } from 'zustand';
import type { TaxonomyFileAssignment } from '@bike4mind/common';
import type { FolderTreeNode, WizardFile } from '../utils/folderTreeParser';
import {
  parseFilesToTree,
  getAllFiles,
  toggleFolderExclusion,
  reapplyExclusions,
  DEFAULT_EXCLUDED_PATTERNS,
} from '../utils/folderTreeParser';

// ── Types ───────────────────────────────────────────────────────────────────

export type WizardStep = 'source' | 'preview' | 'taxonomy' | 'config' | 'upload';

/** The two tabs of the Data Lakes management panel: own lakes vs. the public discover catalog. */
export type ManagerTab = 'mine' | 'discover';

export interface TaxonomyTag {
  /**
   * The editable part of the tag AFTER the shared prefix, e.g. "type:contract". The full
   * applied tag is `taxonomy.prefix + suffix`, so the prefix lives in exactly one place
   * (taxonomy.prefix) and can never be duplicated or drift into a tag's own text.
   */
  suffix: string;
  /**
   * The full name inference assigned (incl. its original prefix), kept stable across user
   * edits. Per-file assignments reference it, so it is the join key at upload time.
   */
  originalName: string;
  /** Confidence/relevance score 0.0-1.0 */
  strength: number;
  /** How this tag was inferred */
  source: 'folder' | 'ai';
  /** Folder paths this tag covers; drives both the review preview and which files get it */
  matchingFolders: string[];
  /** Whether this tag has been soft-deleted by the user */
  deleted: boolean;
}

export interface TaxonomyResult {
  /**
   * The single shared tag prefix (kept in sync with config.tagPrefix). Every tag is
   * `prefix + tag.suffix`, so editing this one value re-namespaces every card at once.
   */
  prefix: string;
  suggestedName: string;
  tags: TaxonomyTag[];
  /** Per-file tag suggestions for the sampled files (inference only samples a subset) */
  fileAssignments: TaxonomyFileAssignment[];
  /** Inference has been run - success OR failure. Never gates progression; the step is optional. */
  attempted: boolean;
  analyzing: boolean;
}

/**
 * Which of the two optional steps the user opted into on the source step. Both default off,
 * so the minimal create path is name + files -> config -> upload; enabling one splices it back
 * into the wizard's step order. Only mutable while on the source step, which is what keeps the
 * current step from ever being spliced out from under the user.
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
}

// ── Defaults ────────────────────────────────────────────────────────────────

/** A taxonomy that applies nothing - the upload path's stand-in when the step is not in play. */
export const EMPTY_TAXONOMY: TaxonomyResult = {
  prefix: '',
  suggestedName: '',
  tags: [],
  fileAssignments: [],
  attempted: false,
  analyzing: false,
};

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
 * files, config, or taxonomy - the fields are a synced set (e.g. taxonomy.prefix <-> config
 * .tagPrefix), so resetting only some of them would desync them.
 */
const freshSession = () => ({
  step: 'source' as WizardStep,
  folderTree: null,
  allFiles: [] as WizardFile[],
  excludedPatterns: [...DEFAULT_EXCLUDED_PATTERNS],
  taxonomy: { ...EMPTY_TAXONOMY },
  optionalSteps: { ...DEFAULT_OPTIONAL_STEPS },
  config: { ...DEFAULT_CONFIG },
  duplicateCheckResults: null,
  uploadProgress: { ...DEFAULT_UPLOAD_PROGRESS },
  hashingProgress: { total: 0, completed: 0, status: 'idle' as const },
  targetLake: null as WizardTargetLake | null,
});

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * When set, the wizard runs in "append" mode: it uploads into this existing lake
 * instead of creating a new one (skips lake creation + the taxonomy step, and
 * locks the Config fields to the existing lake's values).
 */
export interface WizardTargetLake {
  id: string;
  slug: string;
  name: string;
  fileTagPrefix: string;
  requiredUserTag?: string;
  requiredEntitlement?: string;
}

/**
 * Whether the AI taxonomy step is part of this session's flow, and therefore whether its
 * reviewed tags get applied at upload. Toggling the step back off deliberately leaves
 * taxonomy.tags in the store - re-enabling it restores the user's edits without paying for
 * another inference run - so the step's presence in the flow, never the presence of tags, is
 * the authority. Shared by the wizard's step order and the upload path so they cannot drift.
 */
export function isTaxonomyStepActive(state: {
  optionalSteps: OptionalSteps;
  targetLake: WizardTargetLake | null;
}): boolean {
  return !state.targetLake && state.optionalSteps.taxonomy;
}

interface DataLakeWizardStore {
  // State
  isOpen: boolean;
  step: WizardStep;
  folderTree: FolderTreeNode | null;
  allFiles: WizardFile[];
  excludedPatterns: string[];
  taxonomy: TaxonomyResult;
  /** Opt-ins for the two skippable steps; drives the wizard's step order. */
  optionalSteps: OptionalSteps;
  config: DataLakeFormValues;
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

  // Taxonomy step
  setTaxonomy: (result: TaxonomyResult) => void;
  setTaxonomyAnalyzing: (analyzing: boolean) => void;
  markTaxonomyAttempted: () => void;
  updateTag: (originalName: string, updates: Partial<TaxonomyTag>) => void;
  mergeTags: (sourceOriginalName: string, targetOriginalName: string) => void;
  deleteTag: (originalName: string) => void;
  setTagPrefix: (prefix: string) => void;

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
  taxonomy: { ...EMPTY_TAXONOMY },
  optionalSteps: { ...DEFAULT_OPTIONAL_STEPS },
  config: { ...DEFAULT_CONFIG },
  duplicateCheckResults: null,
  uploadProgress: { ...DEFAULT_UPLOAD_PROGRESS },
  hashingProgress: { total: 0, completed: 0, status: 'idle' as const },
  targetLake: null,
  isManagerOpen: false,
  managerTab: 'mine',

  // ── Navigation ──────────────────────────────────────────────────────────

  // Always a clean session: taxonomy now drives the tags files are uploaded with, and config
  // .tagPrefix is synced to taxonomy.prefix, so a stale prior session must not leak in.
  openWizard: () => set({ isOpen: true, ...freshSession() }),

  // Management panel (list lakes, add files, lifecycle). Its internal "Create"
  // button calls openWizard, which stacks the wizard on top and returns here on close.
  // An optional tab lets callers deep-link straight to the public discover catalog.
  openManager: (tab: ManagerTab = 'mine') => set({ isManagerOpen: true, managerTab: tab }),
  closeManager: () => set({ isManagerOpen: false }),

  // Append mode: upload into an existing lake. Preseeds config from the lake so
  // the (locked) Config step shows the right values; taxonomy is skipped.
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
    const { folderTree } = get();
    if (!folderTree) return;
    const updated = toggleFolderExclusion(folderTree, path);
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

  // ── Taxonomy Step ───────────────────────────────────────────────────────

  setTaxonomy: result =>
    set({
      taxonomy: result,
      // Auto-fill config from the suggestion, but a value the user already typed wins - else
      // a Re-analyze would silently overwrite the name/prefix they set on the Config step.
      config: {
        ...get().config,
        name: get().config.name || result.suggestedName,
        tagPrefix: get().config.tagPrefix || result.prefix,
      },
    }),

  setTaxonomyAnalyzing: analyzing => set(state => ({ taxonomy: { ...state.taxonomy, analyzing } })),

  // Failure path: inference is optional, so a failed run still counts as attempted -
  // otherwise the step shows a blank pane instead of its empty state + Re-analyze.
  markTaxonomyAttempted: () => set(state => ({ taxonomy: { ...state.taxonomy, attempted: true, analyzing: false } })),

  // All three mutators key on originalName (stable inference id), never the editable suffix:
  // editing one tag's suffix to match another's would otherwise make a delete hit both.
  updateTag: (originalName, updates) =>
    set(state => ({
      taxonomy: {
        ...state.taxonomy,
        tags: state.taxonomy.tags.map(t => (t.originalName === originalName ? { ...t, ...updates } : t)),
      },
    })),

  mergeTags: (sourceOriginalName, targetOriginalName) =>
    set(state => {
      const sourceTag = state.taxonomy.tags.find(t => t.originalName === sourceOriginalName);
      const targetTag = state.taxonomy.tags.find(t => t.originalName === targetOriginalName);
      if (!sourceTag || !targetTag) return state;

      return {
        taxonomy: {
          ...state.taxonomy,
          tags: state.taxonomy.tags.map(t => {
            if (t.originalName === targetOriginalName) {
              return {
                ...t,
                matchingFolders: [...new Set([...t.matchingFolders, ...sourceTag.matchingFolders])],
                strength: Math.max(t.strength, sourceTag.strength),
              };
            }
            if (t.originalName === sourceOriginalName) {
              return { ...t, deleted: true };
            }
            return t;
          }),
        },
      };
    }),

  deleteTag: originalName =>
    set(state => ({
      taxonomy: {
        ...state.taxonomy,
        tags: state.taxonomy.tags.map(t => (t.originalName === originalName ? { ...t, deleted: true } : t)),
      },
    })),

  // The Tag Prefix's single editable home is the taxonomy step (#829): the prefix is
  // embedded in every applied tag name there and consumed by Re-analyze. Kept in sync with
  // config.tagPrefix so the Config gate and append-mode display read one value.
  setTagPrefix: prefix =>
    set(state => ({
      taxonomy: { ...state.taxonomy, prefix },
      config: { ...state.config, tagPrefix: prefix },
    })),

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
