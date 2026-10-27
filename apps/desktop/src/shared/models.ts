/** The Models screen's IPC types and the pure rules main and the renderer share. */

export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

export type ModelHubErrorKind =
  | 'runtime-unavailable'
  | 'hub-unreachable'
  | 'rate-limited'
  | 'gated'
  | 'not-found'
  | 'unverified'
  | 'license-required'
  | 'access-required'
  | 'already-pulling'
  | 'cannot-pull'
  | 'changed'
  // A curated build's weights, layers or licenses no longer match what was reviewed.
  | 'upstream-changed'
  | 'interrupted'
  | 'cancelled'
  | 'invalid'
  | 'failed';

export interface ModelHubError {
  kind: ModelHubErrorKind;
  message: string;
  /** Rate limits only, when Hugging Face said how long to wait (ms). */
  retryAfterMs?: number | null;
}

export interface ModelRuntimeStatus {
  reachable: boolean;
  version: string | null;
  url: string;
  error: string | null;
}

export interface LocalModelCapabilities {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  embeddings: boolean;
  completion: boolean;
}

export type FitLevel = 'fits' | 'tight' | 'too-large';

/** Whether a model fits this computer's memory; `detail` is the badge's tooltip. */
export interface ModelFit {
  level: FitLevel;
  detail: string;
  /** 'size': estimated from the file size alone, because the model's layer shapes are unknown. */
  basis: 'arch' | 'size';
  /** Tokens of context the estimate assumes: the num_ctx local chat sends for this model. */
  context: number;
}

export interface MachineView {
  memoryKind: 'unified' | 'discrete' | 'cpu';
  totalMemoryBytes: number;
  /** Null on unified memory and when no GPU could be measured. */
  gpuMemoryBytes: number | null;
  gpuName: string | null;
}

export interface LocalModelEntry {
  name: string;
  sizeBytes: number | null;
  quantization: string | null;
  family: string | null;
  parameterSize: string | null;
  modifiedAt: string | null;
  capabilities: LocalModelCapabilities;
  loaded: boolean;
  fit: ModelFit | null;
}

export type InstalledModelsResult = { ok: true; models: LocalModelEntry[] } | { ok: false; error: ModelHubError };

export type HubGatedMode = false | 'auto' | 'manual';

export interface HubModelCard {
  id: string;
  author: string | null;
  downloads: number | null;
  likes: number | null;
  updatedAt: string | null;
  /** Every declared license id; the repo is bound by all of them. */
  licenses: string[];
  gated: HubGatedMode;
  private: boolean;
  abliterated: boolean;
}

export interface HubSearchRequest {
  query: string;
  cursor?: string | null;
}

export type HubSearchResult =
  { ok: true; models: HubModelCard[]; nextCursor: string | null } | { ok: false; error: ModelHubError };

export type LicenseKind = 'permissive' | 'restricted';

export interface HubBuildView {
  id: string;
  quant: string | null;
  sizeBytes: number;
  /** The `hf.co/...` name Ollama would list it under, as planned from the file list. */
  ollamaRef: string | null;
  /** Why the build cannot be pulled; null when it can be offered (the registry check still runs first). */
  blockedReason: string | null;
  fit: ModelFit | null;
}

export interface HubModelView extends HubModelCard {
  url: string;
  revision: string;
  /** Shown names, one per declared license (`other` replaced by the card's `license_name`); empty when none. */
  licenseNames: string[];
  licenseUrl: string;
  /** Where `licenseUrl` goes, shown beside the link because a card may point off Hugging Face. */
  licenseHost: string;
  licenseKind: LicenseKind;
  baseModels: string[];
  builds: HubBuildView[];
  /** Largest vision projector; Ollama adds one projector to each pull from this repo. */
  projectorBytes: number | null;
  /** Gated or private: Ollama needs its SSH key on the user's Hugging Face account. */
  needsAccess: boolean;
}

export type HubDetailResult = { ok: true; model: HubModelView } | { ok: false; error: ModelHubError };

/** The Curated tab's per-machine roles; CPU-only machines get a light pick where GPUs get a long-context one. */
export type CuratedSlot = 'best' | 'fast' | 'long-context' | 'light';

export interface CuratedBuildView {
  /** The manifest's build id. */
  id: string;
  /** The pull's repo: a Hugging Face repo, or the Ollama library ref for a library build. */
  repo: string;
  /** The pull's build id: the Hugging Face build for an hf.co build, the manifest's id for a library build. */
  pullBuildId: string;
  quant: string;
  /** What Ollama downloads, projector included. */
  sizeBytes: number;
  /** The name Ollama lists it under once downloaded. */
  ollamaRef: string;
  fit: ModelFit;
  /** Why Download is off here, such as an Ollama older than the build needs; null when it can be offered. */
  blockedReason: string | null;
}

export interface CuratedEntryView {
  id: string;
  name: string;
  /** One line on why it is on the list. */
  why: string;
  /** e.g. `11.9B` or `25.2B, 3.8B active`. */
  params: string;
  licenseName: string;
  licenseUrl: string;
  /** Permissive only when both the model's and its base model's licenses are. */
  licenseKind: LicenseKind;
  thinking: boolean;
  /** It accepts images. */
  vision: boolean;
  code: boolean;
  /** Its chat template supports tool calls, so chat sends it tools. */
  tools: boolean;
  /** How well it called tools in Bike4Mind's evals; information only, never a reason to withhold tools. */
  toolUse: { rating: 'unrated' | 'weak' | 'ok' | 'strong'; note: string | null };
  /** Where its builds come from: the Ollama library page or the Hugging Face repo. */
  sourceUrl: string;
  sourceName: 'Ollama' | 'Hugging Face';
  builds: CuratedBuildView[];
}

/** One of this computer's picks. */
export interface CuratedPickView {
  slot: CuratedSlot;
  entryId: string;
  buildId: string;
  recommended: boolean;
}

export interface CuratedList {
  /** The list's date, from its updatedAt. */
  updatedAt: string;
  machine: MachineView;
  /** This computer's picks in slot order; empty when the list has none for its memory. */
  picks: CuratedPickView[];
  entries: CuratedEntryView[];
}

/** What the pull dialog shows for a curated build, once its source still serves what was reviewed. */
export type CuratedPullResult =
  { ok: true; model: HubModelView; build: HubBuildView } | { ok: false; error: ModelHubError };

export interface ModelPullRequest {
  repo: string;
  buildId: string;
  /** The commit and size the user reviewed; main refuses with `changed` when the repo has moved on. */
  revision: string;
  sizeBytes: number;
  acceptLicense: boolean;
  confirmAccess: boolean;
  /** Set from Curated: main then also refuses unless the source still serves the reviewed layers. */
  curated?: { entryId: string; buildId: string };
}

export type ModelPullPhase = 'verifying' | 'downloading' | 'finishing' | 'failed';

export interface ModelPull {
  key: string;
  repo: string;
  buildId: string;
  quant: string | null;
  ref: string | null;
  phase: ModelPullPhase;
  completedBytes: number;
  totalBytes: number | null;
  expectedBytes: number;
  error: ModelHubError | null;
}

/** `listed`: the failure stays in the pull list, so the screen need not show it again. */
export type ModelPullResult = { ok: true; ref: string } | { ok: false; error: ModelHubError; listed: boolean };

export type ModelRemoveResult = { ok: true } | { ok: false; error: ModelHubError };

export function pullKey(repo: string, buildId: string): string {
  return `${repo}#${buildId}`;
}

const PERMISSIVE_LICENSES = new Set([
  'apache-2.0',
  'mit',
  'bsd',
  'bsd-2-clause',
  'bsd-3-clause',
  'bsd-3-clause-clear',
  'isc',
]);

/** Permissive only when every declared license is; none at all needs the user to accept the card's terms. */
export function licenseKind(licenses: readonly string[]): LicenseKind {
  return licenses.length > 0 && licenses.every(license => PERMISSIVE_LICENSES.has(license.trim().toLowerCase()))
    ? 'permissive'
    : 'restricted';
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(bytes < 10_000_000_000 ? 2 : 1)} GB`;
}

/** RAM, VRAM and memory estimates in GiB, labelled so, beside download sizes in decimal GB. */
export function formatMemory(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib >= 100 ? Math.round(gib) : Number(gib.toFixed(1))} GiB`;
}

export function formatCount(count: number | null): string {
  if (count === null) return '-';
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
