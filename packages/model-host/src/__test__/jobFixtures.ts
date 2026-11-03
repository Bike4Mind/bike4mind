import type { PullJob, PullJobRequest } from '@bike4mind/common/modelHub';
import {
  loadCuratedManifest,
  ModelNotFoundError,
  type HubGgufBuild,
  type HubModelDetail,
  type InstalledModel,
  type ModelInspection,
  type PullCheckHub,
  type PullOptions,
} from '@bike4mind/local-models';
import { vi } from 'vitest';
import type { AuditEntry } from '../audit';
import type { JobStore, StoredJob } from '../jobStore';
import { JobManager, type JobManagerOptions } from '../jobs';

export const SHA = 'a'.repeat(64);
export const REV = '1'.repeat(40);

export const hubBuild = (overrides: Partial<HubGgufBuild> = {}): HubGgufBuild => ({
  id: 'model-Q4_K_M',
  quant: 'Q4_K_M',
  label: 'Q4_K_M',
  files: [{ path: 'model-Q4_K_M.gguf', sizeBytes: 1000, sha256: SHA, url: 'https://example.test/f' }],
  sizeBytes: 1000,
  split: false,
  complete: true,
  ollamaRef: 'hf.co/org/repo:Q4_K_M',
  ollamaRefIssue: null,
  ...overrides,
});

export const hubDetail = (overrides: Partial<HubModelDetail> = {}): HubModelDetail => ({
  id: 'org/repo',
  author: 'org',
  downloads: null,
  likes: null,
  updatedAt: null,
  pipelineTag: null,
  gated: false,
  private: false,
  licenses: ['apache-2.0'],
  baseModels: [],
  tags: [],
  revision: REV,
  licenseName: null,
  licenseLink: null,
  gguf: null,
  builds: [hubBuild()],
  projectors: [],
  canDownload: true,
  ollamaNeedsSshKey: false,
  ...overrides,
});

export const pullRequest = (overrides: Partial<Extract<PullJobRequest, { source: 'hf' }>> = {}): PullJobRequest => ({
  source: 'hf',
  repo: 'org/repo',
  buildId: 'model-Q4_K_M',
  revision: REV,
  ref: 'hf.co/org/repo:Q4_K_M',
  sha256: SHA,
  sizeBytes: 1000,
  licenses: ['apache-2.0'],
  licenseAccepted: false,
  accessConfirmed: false,
  device: { id: 'device-1', name: 'Laptop' },
  ...overrides,
});

export function fakeHub(answer: () => HubModelDetail | Promise<HubModelDetail>): PullCheckHub {
  return {
    getModel: vi.fn(async () => answer()),
    verifyOllamaRef: vi.fn(async (d: HubModelDetail, b: HubGgufBuild) => `hf.co/${d.id}:${b.label}`),
    ollamaLayers: vi.fn(async () => null),
  };
}

export interface HeldPull {
  ref: string;
  progress: (completed: number, total?: number) => void;
  finish: () => void;
  signal: AbortSignal | undefined;
}

/** An Ollama whose pulls wait until the test finishes them, and fail on abort as fetch does. */
export function fakeRuntime() {
  const installed = new Set<string>();
  const pulls: HeldPull[] = [];
  let blob: string | null = SHA;
  const runtime = {
    health: vi.fn(async () => ({ ok: true, version: '0.40.11', error: null })),
    list: vi.fn(async () => [...installed].map(name => ({ name }) as InstalledModel)),
    inspect: vi.fn(async (name: string): Promise<ModelInspection> => ({
      model: { name } as InstalledModel,
      arch: null,
      tensorStats: null,
      contents: { template: null, license: null, modelBlob: blob, adapterBlobs: [] },
    })),
    remove: vi.fn(async (name: string) => {
      if (!installed.delete(name)) throw new ModelNotFoundError('ollama', name);
    }),
    pull: vi.fn(
      (ref: string, options: PullOptions = {}) =>
        new Promise<void>((resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          pulls.push({
            ref,
            signal: options.signal,
            progress: (completed, total = 1000) =>
              options.onProgress?.({ status: 'pulling', completedBytes: completed, totalBytes: total }),
            finish: () => {
              installed.add(ref);
              resolve();
            },
          });
        })
    ),
  };
  return { runtime, pulls, installed, setBlob: (value: string | null) => (blob = value) };
}

/** Writes to one id land in call order, as in the real store; `delayMs` makes each one slow. */
export function memoryStore(
  initial: StoredJob[] = []
): JobStore & { files: Map<string, StoredJob>; delayMs: number; writes: string[] } {
  const files = new Map(initial.map(record => [record.job.id, record]));
  let chain = Promise.resolve();
  const store = {
    files,
    delayMs: 0,
    writes: [] as string[],
    loadAll: async () => [...files.values()],
    save: (record: StoredJob) => {
      const copy = structuredClone(record);
      const wait = store.delayMs;
      chain = chain.then(async () => {
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        files.set(copy.job.id, copy);
        store.writes.push(`${copy.job.id}:${copy.job.state}`);
      });
      return chain;
    },
    remove: (id: string) => {
      const wait = store.delayMs;
      chain = chain.then(async () => {
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        files.delete(id);
        store.writes.push(`${id}:removed`);
      });
      return chain;
    },
  };
  return store;
}

/** A saved job, for loading into a new manager. */
export function storedJob(
  id: string,
  state: PullJob['state'],
  overrides: Partial<PullJob> = {},
  request: PullJobRequest = pullRequest()
): StoredJob {
  const at = new Date().toISOString();
  return {
    request,
    run: { pulled: false, afterOnly: false },
    job: {
      id,
      state,
      source: 'hf',
      repo: 'org/repo',
      buildId: request.source === 'hf' ? request.buildId : request.curated.buildId,
      ref: request.ref,
      sizeBytes: request.sizeBytes,
      progress: { status: state, completedBytes: 0, totalBytes: null },
      startedBy: { device: 'Laptop', user: null, via: 'local' },
      cancelledBy: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
      error: null,
      notice: null,
      ...overrides,
    },
  };
}

export const jobId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export async function until(check: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A job manager over fakes, recording what it sends to the event stream and the audit log. */
export function createJobs(overrides: Partial<JobManagerOptions> = {}, initial: StoredJob[] = []) {
  const fake = fakeRuntime();
  const hub = fakeHub(() => hubDetail());
  const store = memoryStore(initial);
  const events: PullJob[] = [];
  const dismissed: string[] = [];
  const audits: AuditEntry[] = [];
  const options: JobManagerOptions = {
    runtime: fake.runtime,
    hub: () => hub,
    libraryLayers: async () => null,
    curated: () => loadCuratedManifest(() => {}),
    store,
    audit: entry => audits.push(entry),
    freeBytes: async () => 100e9,
    hostName: 'gpu-box',
    onJob: job => events.push(job),
    onDismissed: id => dismissed.push(id),
    log: () => {},
    inspectRetryMs: [],
    progressEveryMs: 0,
    ...overrides,
  };
  const jobs = new JobManager(options);
  const state = (id: string) => jobs.get(id).state;
  return { jobs, options, fake, hub, store, events, dismissed, audits, state };
}
