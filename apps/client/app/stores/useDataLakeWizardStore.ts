import { create } from 'zustand';
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

export interface TaxonomyTag {
  /** Full tag name, e.g. "acme:type:contract" */
  name: string;
  /** Confidence/relevance score 0.0-1.0 */
  strength: number;
  /** How this tag was inferred */
  source: 'folder' | 'ai';
  /** Sample file names for review */
  sampleFileNames: string[];
  /** Whether this tag has been soft-deleted by the user */
  deleted: boolean;
}

export interface TaxonomyResult {
  prefix: string;
  suggestedName: string;
  tags: TaxonomyTag[];
  analyzed: boolean;
  analyzing: boolean;
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

const DEFAULT_TAXONOMY: TaxonomyResult = {
  prefix: '',
  suggestedName: '',
  tags: [],
  analyzed: false,
  analyzing: false,
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

interface DataLakeWizardStore {
  // State
  isOpen: boolean;
  step: WizardStep;
  folderTree: FolderTreeNode | null;
  allFiles: WizardFile[];
  excludedPatterns: string[];
  taxonomy: TaxonomyResult;
  config: DataLakeFormValues;
  duplicateCheckResults: { duplicateCount: number; checkedAt: number } | null;
  uploadProgress: UploadProgress;
  hashingProgress: { total: number; completed: number; status: 'idle' | 'hashing' | 'done' };
  /** Non-null when appending to an existing lake (vs creating a new one). */
  targetLake: WizardTargetLake | null;
  /** Drives the Data Lakes management panel (list + lifecycle), distinct from the wizard. */
  isManagerOpen: boolean;

  // Navigation
  openWizard: () => void;
  openWizardForLake: (lake: WizardTargetLake) => void;
  closeWizard: () => void;
  openManager: () => void;
  closeManager: () => void;
  setStep: (step: WizardStep) => void;

  // Source step
  setFiles: (files: File[]) => void;

  // Preview step
  toggleFolderExclusion: (path: string) => void;
  setExcludedPatterns: (patterns: string[]) => void;

  // Taxonomy step
  setTaxonomy: (result: TaxonomyResult) => void;
  setTaxonomyAnalyzing: (analyzing: boolean) => void;
  updateTag: (tagName: string, updates: Partial<TaxonomyTag>) => void;
  mergeTags: (sourceTagName: string, targetTagName: string) => void;
  deleteTag: (tagName: string) => void;
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
  taxonomy: { ...DEFAULT_TAXONOMY },
  config: { ...DEFAULT_CONFIG },
  duplicateCheckResults: null,
  uploadProgress: { ...DEFAULT_UPLOAD_PROGRESS },
  hashingProgress: { total: 0, completed: 0, status: 'idle' as const },
  targetLake: null,
  isManagerOpen: false,

  // ── Navigation ──────────────────────────────────────────────────────────

  openWizard: () => set({ isOpen: true, step: 'source', targetLake: null }),

  // Management panel (list lakes, add files, lifecycle). Its internal "Create"
  // button calls openWizard, which stacks the wizard on top and returns here on close.
  openManager: () => set({ isManagerOpen: true }),
  closeManager: () => set({ isManagerOpen: false }),

  // Append mode: upload into an existing lake. Preseeds config from the lake so
  // the (locked) Config step shows the right values; taxonomy is skipped.
  openWizardForLake: lake =>
    set(state => ({
      isOpen: true,
      step: 'source',
      targetLake: lake,
      config: {
        ...state.config,
        name: lake.name,
        tagPrefix: lake.fileTagPrefix,
        requiredUserTag: lake.requiredUserTag ?? '',
        requiredEntitlement: lake.requiredEntitlement ?? '',
      },
    })),

  closeWizard: () => set({ isOpen: false }),

  setStep: step => set({ step }),

  // ── Source Step ─────────────────────────────────────────────────────────

  setFiles: files => {
    const { excludedPatterns } = get();
    const tree = parseFilesToTree(files, excludedPatterns);
    const allFiles = getAllFiles(tree);
    set({ folderTree: tree, allFiles });
  },

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
      // Auto-fill config from taxonomy suggestion
      config: {
        ...get().config,
        name: result.suggestedName || get().config.name,
        tagPrefix: result.prefix || get().config.tagPrefix,
      },
    }),

  setTaxonomyAnalyzing: analyzing => set(state => ({ taxonomy: { ...state.taxonomy, analyzing } })),

  updateTag: (tagName, updates) =>
    set(state => ({
      taxonomy: {
        ...state.taxonomy,
        tags: state.taxonomy.tags.map(t => (t.name === tagName ? { ...t, ...updates } : t)),
      },
    })),

  mergeTags: (sourceTagName, targetTagName) =>
    set(state => {
      const sourceTag = state.taxonomy.tags.find(t => t.name === sourceTagName);
      const targetTag = state.taxonomy.tags.find(t => t.name === targetTagName);
      if (!sourceTag || !targetTag) return state;

      return {
        taxonomy: {
          ...state.taxonomy,
          tags: state.taxonomy.tags.map(t => {
            if (t.name === targetTagName) {
              return {
                ...t,
                sampleFileNames: [...new Set([...t.sampleFileNames, ...sourceTag.sampleFileNames])],
                strength: Math.max(t.strength, sourceTag.strength),
              };
            }
            if (t.name === sourceTagName) {
              return { ...t, deleted: true };
            }
            return t;
          }),
        },
      };
    }),

  deleteTag: tagName =>
    set(state => ({
      taxonomy: {
        ...state.taxonomy,
        tags: state.taxonomy.tags.map(t => (t.name === tagName ? { ...t, deleted: true } : t)),
      },
    })),

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

  resetWizard: () =>
    set({
      isOpen: false,
      step: 'source',
      folderTree: null,
      allFiles: [],
      excludedPatterns: [...DEFAULT_EXCLUDED_PATTERNS],
      taxonomy: { ...DEFAULT_TAXONOMY },
      config: { ...DEFAULT_CONFIG },
      duplicateCheckResults: null,
      uploadProgress: { ...DEFAULT_UPLOAD_PROGRESS },
      hashingProgress: { total: 0, completed: 0, status: 'idle' as const },
      targetLake: null,
    }),
}));
