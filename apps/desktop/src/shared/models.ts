/** The Models screen's IPC types and the pure rules main and the renderer share. */

import { LOCAL_SERVER_ID, type ModelServerManagement } from './modelServers';

export type { ModelServerManagement };

export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
export const HUGGING_FACE_TOKENS_URL = 'https://huggingface.co/settings/tokens';
export const HUGGING_FACE_SSH_KEYS_URL = 'https://huggingface.co/settings/keys';

export type ModelHubErrorKind =
  | 'runtime-unavailable'
  | 'hub-unreachable'
  | 'rate-limited'
  | 'gated'
  | 'token-rejected'
  | 'not-found'
  | 'unverified'
  | 'license-required'
  | 'access-required'
  | 'already-pulling'
  | 'cannot-pull'
  | 'changed'
  | 'interrupted'
  | 'connection-lost'
  | 'not-allowed'
  | 'credentials'
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
  /** `local` for this computer, otherwise a saved model server's id (see @shared/modelServers). */
  serverId: string;
  serverName: string;
  management: ModelServerManagement;
}

export interface LocalModelCapabilities {
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  embeddings: boolean;
  completion: boolean;
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
  /** Unique within the repo: the quant, plus what sets the file apart when other builds share it (`QAD-Q4_0`). */
  label: string;
  sizeBytes: number;
  /** The name Ollama would list it under, as planned from the file list: `hf.co/...`, or `huggingface.co/...` when gated or private. */
  ollamaRef: string | null;
  /** Lower-case names an installed copy of this build may be listed under: the repo can be pulled as hf.co or huggingface.co. */
  installedNames: string[];
  /** Why the build cannot be pulled; null when it can be offered (the registry check still runs first). */
  blockedReason: string | null;
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
  /**
   * For a gated or private repo, what the saved Hugging Face token can read: `no-token` without one, `granted` when
   * its files are readable, `denied` when the Hub refused it, `unknown` when there was no file to try.
   */
  hubAccess: HubAccess;
}

export type HubAccess = 'no-token' | 'granted' | 'denied' | 'unknown';

/** Only whether a token is saved ever reaches the renderer, never the token. */
export interface HfTokenStatus {
  set: boolean;
  /** False with no OS keychain: the token lasts until the app quits. */
  persisted: boolean;
}

export type HfTokenResult = { ok: true; status: HfTokenStatus } | { ok: false; error: ModelHubError };

export type HubDetailResult = { ok: true; model: HubModelView } | { ok: false; error: ModelHubError };

export interface ModelPullRequest {
  repo: string;
  buildId: string;
  /** The commit and size the user reviewed; main refuses with `changed` when the repo has moved on. */
  revision: string;
  sizeBytes: number;
  acceptLicense: boolean;
  confirmAccess: boolean;
  /** The server to pull to; omitted means this computer. */
  serverId?: string;
}

/** `paused`: the connection to a model server dropped mid-download; resuming continues from its partial file. */
export type ModelPullPhase = 'verifying' | 'downloading' | 'finishing' | 'paused' | 'failed';

export interface ModelPull {
  key: string;
  serverId: string;
  serverName: string;
  repo: string;
  buildId: string;
  /** The build's `HubBuildView.label`; null until main has read the build. */
  label: string | null;
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

export function pullKey(repo: string, buildId: string, serverId: string = LOCAL_SERVER_ID): string {
  return serverId === LOCAL_SERVER_ID ? `${repo}#${buildId}` : `${serverId}/${repo}#${buildId}`;
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

export function formatCount(count: number | null): string {
  if (count === null) return '-';
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
