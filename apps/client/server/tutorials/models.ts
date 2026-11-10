import { mongoose } from '@bike4mind/database';

export const TUTORIAL_MODULE_STATUSES = ['in_progress', 'finished', 'left'] as const;
export type TutorialModuleStatus = (typeof TUTORIAL_MODULE_STATUSES)[number];

export const TUTORIAL_MODULE_ID = /^[a-z0-9-]{1,40}$/;

export interface ITutorialModuleProgress {
  status: TutorialModuleStatus;
  stepId?: string;
  sessionId: string;
  /** Highest recorded turn answered in the session; 0 is the opening message, -1 before it is sent. */
  turn: number;
  moduleVersion: number;
  /** The module's revision when the walk started; absent on walks begun before revisions existed, read as 0. */
  moduleRevision?: number;
  /** When `turn` last moved; a retry reads it to tell an in-flight insert from an abandoned one. */
  turnClaimedAt: Date;
  updatedAt: Date;
}

export interface ITutorialProgress {
  userId: string;
  modules: Map<string, ITutorialModuleProgress>;
  journeys: Map<string, { dismissedAt?: Date }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITutorialOverride {
  moduleId: string;
  /** Absent leaves the repo's own switch. An override can hold a module back, never release one the repo holds. */
  enabled?: boolean;
  /** Only ever increases. A running walk whose revision differs is told the tutorial changed. */
  revision: number;
  /** Increases on every write, so a cached copy of the module can tell it is stale. */
  contentSeq: number;
  /** Override units, schema-parsed on every read; a row that fails to parse falls back to the repo module. */
  fields?: unknown[];
  /** Digest of the structural edits last applied, and the repo version that computed it. */
  structuralDigest?: string;
  digestRepoVersion?: number;
  updatedBy: string;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITutorialOverrideChange {
  moduleId: string;
  field: string;
  /** JSON of the value before and after; null when the field was unset. */
  before: string | null;
  after: string | null;
  actorId: string;
  reason: string;
  createdAt: Date;
}

export interface ITutorialDraft {
  moduleId: string;
  title: string;
  pitch: string;
  /** The session it was captured from: the admin's own, unshared, untouched by a tutorial. */
  sourceSessionId: string;
  transcript: unknown[];
  canvas?: unknown;
  sheet?: { name: string; csv: string };
  steps: unknown[];
  canvasNodeId?: string;
  finale: { title: string; body: string };
  /** Moves on every content save, so a learner's running walk of the old content is told it changed. */
  revision: number;
  /** Moves on every write of content; approval names the sequence it approved. */
  contentSeq: number;
  /** The content sequence the admin approved in the preview; any later content save leaves it behind. */
  approvedSeq?: number;
  enabled: boolean;
  capturedBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TutorialModels {
  Progress: mongoose.Model<ITutorialProgress>;
  Override: mongoose.Model<ITutorialOverride>;
  OverrideChange: mongoose.Model<ITutorialOverrideChange>;
  Draft: mongoose.Model<ITutorialDraft>;
}

export interface TutorialModelNames {
  /** Collection name prefix: core passes an empty string, an owner its own lowercase name. */
  prefix: string;
  /** Mongoose model name prefix: `Core` gives `CoreTutorialProgress`. */
  modelPrefix: string;
}

const registered = <T>(name: string, define: () => mongoose.Model<T>): mongoose.Model<T> =>
  (mongoose.models[name] as mongoose.Model<T>) || define();

function buildModels({ prefix, modelPrefix }: TutorialModelNames): TutorialModels {
  const ModuleProgressSchema = new mongoose.Schema<ITutorialModuleProgress>(
    {
      status: { type: String, enum: TUTORIAL_MODULE_STATUSES, required: true },
      stepId: { type: String },
      sessionId: { type: String, required: true },
      turn: { type: Number, required: true, min: -1 },
      moduleVersion: { type: Number, required: true },
      moduleRevision: { type: Number, min: 0 },
      turnClaimedAt: { type: Date, required: true },
      updatedAt: { type: Date, required: true },
    },
    { _id: false }
  );

  const ProgressSchema = new mongoose.Schema<ITutorialProgress>(
    {
      userId: { type: String, required: true, unique: true },
      modules: { type: Map, of: ModuleProgressSchema, default: {} },
      journeys: { type: Map, of: new mongoose.Schema({ dismissedAt: Date }, { _id: false }), default: {} },
    },
    { timestamps: true, collection: `${prefix}tutorialprogress` }
  );

  const OverrideSchema = new mongoose.Schema<ITutorialOverride>(
    {
      moduleId: { type: String, required: true, unique: true, match: TUTORIAL_MODULE_ID },
      enabled: { type: Boolean },
      revision: { type: Number, required: true, default: 0, min: 0 },
      contentSeq: { type: Number, required: true, default: 0, min: 0 },
      fields: { type: [mongoose.Schema.Types.Mixed], default: undefined },
      structuralDigest: { type: String },
      digestRepoVersion: { type: Number, min: 0 },
      updatedBy: { type: String, required: true },
      reason: { type: String, required: true },
    },
    { timestamps: true, collection: `${prefix}tutorialoverrides` }
  );

  const OverrideChangeSchema = new mongoose.Schema<ITutorialOverrideChange>(
    {
      moduleId: { type: String, required: true },
      field: { type: String, required: true },
      before: { type: String, default: null },
      after: { type: String, default: null },
      actorId: { type: String, required: true },
      reason: { type: String, required: true },
    },
    { timestamps: { createdAt: true, updatedAt: false }, collection: `${prefix}tutorialoverridechanges` }
  );
  OverrideChangeSchema.index({ moduleId: 1, createdAt: -1 });

  const DraftSchema = new mongoose.Schema<ITutorialDraft>(
    {
      moduleId: { type: String, required: true, unique: true, match: TUTORIAL_MODULE_ID },
      title: { type: String, required: true },
      pitch: { type: String, default: '' },
      sourceSessionId: { type: String, required: true },
      transcript: { type: [mongoose.Schema.Types.Mixed], default: [] },
      canvas: { type: mongoose.Schema.Types.Mixed },
      sheet: { type: mongoose.Schema.Types.Mixed },
      steps: { type: [mongoose.Schema.Types.Mixed], default: [] },
      canvasNodeId: { type: String },
      finale: { type: mongoose.Schema.Types.Mixed, required: true },
      revision: { type: Number, required: true, default: 0, min: 0 },
      contentSeq: { type: Number, required: true, default: 0, min: 0 },
      approvedSeq: { type: Number, min: 0 },
      enabled: { type: Boolean, required: true, default: false },
      capturedBy: { type: String, required: true },
      updatedBy: { type: String, required: true },
    },
    { timestamps: true, collection: `${prefix}tutorialdrafts`, minimize: false }
  );
  DraftSchema.index({ enabled: 1 });

  const name = (suffix: string) => `${modelPrefix}Tutorial${suffix}`;
  return {
    Progress: registered(name('Progress'), () => mongoose.model<ITutorialProgress>(name('Progress'), ProgressSchema)),
    Override: registered(name('Override'), () => mongoose.model<ITutorialOverride>(name('Override'), OverrideSchema)),
    OverrideChange: registered(name('OverrideChange'), () =>
      mongoose.model<ITutorialOverrideChange>(name('OverrideChange'), OverrideChangeSchema)
    ),
    Draft: registered(name('Draft'), () => mongoose.model<ITutorialDraft>(name('Draft'), DraftSchema)),
  };
}

const memo = new Map<string, TutorialModels>();

/** One set of tutorial models per owner. An owner passes its own prefixes to keep reading rows it already stores. */
export function tutorialModels(names: TutorialModelNames): TutorialModels {
  const key = `${names.prefix}\u0000${names.modelPrefix}`;
  let models = memo.get(key);
  if (!models) {
    models = buildModels(names);
    memo.set(key, models);
  }
  return models;
}
