import type { StudioAsset, StudioContextSelection, StudioJob, StudioMediaKind } from '@shared/studio';

export interface StudioSettingsByKind {
  image: { size?: string; model?: string };
  video: { durationSeconds?: number; aspectRatio?: string; resolution?: string };
  music: { durationSeconds?: number; instrumental?: boolean };
  speech: { voice?: string; format?: string };
  'sound-effect': { durationSeconds?: number; promptInfluence?: number };
}

type SettingField<K extends StudioMediaKind> = {
  [P in keyof StudioSettingsByKind[K]]: {
    key: P;
    label: string;
  } & (NonNullable<StudioSettingsByKind[K][P]> extends string
    ? { type: 'choice'; options: readonly { label: string; value: string }[] }
    : NonNullable<StudioSettingsByKind[K][P]> extends number
      ? { type: 'number'; min: number; max: number; step?: number }
      : { type: 'boolean' });
}[keyof StudioSettingsByKind[K]];

export type StudioCapabilities = {
  [K in StudioMediaKind]?:
    | { status: 'available'; fields?: readonly NonNullable<SettingField<K>>[] }
    | { status: 'loading' | 'unsupported' | 'unavailable'; reason: string };
};

export interface StudioIdentity {
  sessionId: string;
  workspaceId: string;
  /** Changes with context/configuration, not background job progress. Main must validate again. */
  revision: string;
}

export type StudioCreationDraft = {
  [K in StudioMediaKind]: StudioIdentity & {
    kind: K;
    prompt: string;
    selection: StudioContextSelection;
    settings: StudioSettingsByKind[K];
  };
}[StudioMediaKind];

export interface StudioReview {
  id: string;
  preparedPrompt: string;
  sources: readonly { sessionId: string; title: string }[];
  exclusions: readonly string[];
  truncation: readonly string[];
  warnings: readonly string[];
}

export interface StudioController extends StudioIdentity {
  familyLabel: string;
  sessions: readonly { id: string; title: string }[];
  capabilities: StudioCapabilities;
  state:
    | { status: 'loading' }
    | { status: 'error'; error: string }
    | { status: 'ready'; assets: readonly StudioAsset[]; jobs: readonly StudioJob[] };
  busy?: boolean;
  hasMoreAssets?: boolean;
  hasMoreJobs?: boolean;
  loadMore?: (collection: 'assets' | 'jobs') => Promise<void>;
  jobAction?: (jobId: string, action: 'recheck' | 'cancel') => Promise<void>;
  pickFiles?: () => Promise<string[]>;
  prepareCreation(draft: StudioCreationDraft): Promise<StudioReview>;
  create(request: { draft: StudioCreationDraft; reviewId: string; preparedPrompt: string }): Promise<void>;
  previewAsset?: (asset: StudioAsset) => Promise<void>;
  renameAsset?: (asset: StudioAsset, title: string) => Promise<void>;
  deleteAsset?: (asset: StudioAsset) => Promise<void>;
  exportAsset?: (asset: StudioAsset) => Promise<void>;
  reuseAsset?: (asset: StudioAsset) => Promise<void>;
  assetActionReasons?: Partial<Record<'preview' | 'rename' | 'delete' | 'export' | 'reuse', string>>;
}
