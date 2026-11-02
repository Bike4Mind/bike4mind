import { randomUUID } from 'node:crypto';
import {
  PULL_JOB_ACTIVE_STATES,
  PULL_JOB_FINAL_STATES,
  type HubBuild,
  type HubEntry,
  type HubManifest,
  type PullApprovedLayers,
  type PullJob,
  type PullJobActor,
  type PullJobRequest,
  type PullJobState,
} from '@bike4mind/common/modelHub';
import {
  checkApproval,
  checkInstalledBlob,
  checkInstalledDigest,
  curatedLibrary,
  curatedPins,
  curatedRunner,
  isCuratedListable,
  licensesChanged,
  ModelNotFoundError,
  ollamaModelKey,
  ollamaPullRef,
  ollamaRefAliases,
  sameRepo,
  type ApprovalDeps,
  type ApprovalFailure,
  type HubModelDetail,
  type LayerSources,
  type LocalRuntime,
  type ModelInspection,
  type PullCheckHub,
  type PullProgress,
} from '@bike4mind/local-models';
import type { Audit, AuditEntry } from './audit';
import type { JobStore, RunState } from './jobStore';
import { HttpError } from './server';

export type JobRuntime = Pick<LocalRuntime, 'health' | 'list' | 'inspect' | 'pull' | 'remove'>;

export interface JobManagerOptions {
  runtime: JobRuntime;
  /** A Hub client with no token: the host never holds account credentials. */
  hub: () => PullCheckHub;
  libraryLayers: LayerSources['libraryLayers'];
  /** The host's own curated list; a curated approval must name a build in it. */
  curated: () => HubManifest;
  store: JobStore;
  audit: Audit;
  /** Free bytes on the model store's filesystem, read fresh; null when unknown, which admits the pull. */
  freeBytes: () => Promise<number | null>;
  hostName: string;
  onJob: (job: PullJob) => void;
  onDismissed: (id: string) => void;
  log: (line: string) => void;
  /** Kept free on the store after every admitted pull. */
  floorBytes?: number;
  /** Progress reaches the event stream at most this often per job (ms). */
  progressEveryMs?: number;
  /** Progress is written to the job file at most this often; state changes always are (ms). */
  saveEveryMs?: number;
  /** Jobs checking, downloading or verifying at once. */
  maxActive?: number;
  /** Jobs not finished, paused and interrupted ones included. */
  maxJobs?: number;
  /** Finished jobs kept for listing; older ones are dismissed. */
  maxKept?: number;
  /** Pauses between reads of a just-pulled model that Ollama could not describe yet (ms). */
  inspectRetryMs?: readonly number[];
  /** The whole check of the installed weights, retries included; shutdown waits this long for one (ms). */
  verifyTimeoutMs?: number;
  pullIdleTimeoutMs?: number;
  /** A job resumed after a pause longer than this may start over, so its partial bytes are not credited (ms). */
  staleAfterMs?: number;
  now?: () => Date;
}

export const DEFAULT_FLOOR_BYTES = 2 * 1024 ** 3;
export const DEFAULT_MAX_JOBS = 32;
export const DEFAULT_MAX_KEPT = 200;
const STOP_WAIT_MS = 15_000;
const CHECK_TIMEOUT_MS = 30_000;
const L_STATUS = 256;
const L_MESSAGE = 1000;

type StopReason = 'cancel' | 'pause' | 'shutdown' | 'space';

interface Entry {
  job: PullJob;
  request: PullJobRequest;
  run: RunState;
  controller: AbortController | null;
  stop: StopReason | null;
  task: Promise<void> | null;
  /** Held from the first await of a create or resume until its run starts; cancel waits for it. */
  starting: Promise<void> | null;
  plan: Plan | null;
  verifying: boolean;
  spaceRechecked: boolean;
  spaceRefusal: string | null;
  lastEmit: number;
  emitTimer: NodeJS.Timeout | null;
  lastSave: number;
}

type Verify = { kind: 'curated'; build: HubBuild } | { kind: 'blob'; sha256: string };
interface Plan {
  ok: true;
  ref: string;
  runner?: string;
  verify: Verify;
  notice: string | null;
  afterOnly: boolean;
  /** The Hub hid the repo, so its size was never read either. */
  hidden: boolean;
}
type Refusal = { ok: false; code: string; message: string };
type Room = { ok: true; unknown: boolean } | { ok: false; message: string };

const ACTIVE: readonly PullJobState[] = PULL_JOB_ACTIVE_STATES;
const FINAL: readonly PullJobState[] = PULL_JOB_FINAL_STATES;
export const isActive = (state: PullJobState) => ACTIVE.includes(state);
export const isFinal = (state: PullJobState) => FINAL.includes(state);

// eslint-disable-next-line no-control-regex -- control characters are what it strips
const CONTROL = /[\u0000-\u001f\u007f]/g;
const clip = (text: string, max = L_MESSAGE) => {
  const plain = text.replace(CONTROL, ' ');
  return plain.length > max ? `${plain.slice(0, max)}...` : plain;
};
const errorText = (error: unknown) => clip(error instanceof Error ? error.message : String(error));
const refuse = (code: string, message: string): Refusal => ({ ok: false, code, message });
const joinNotices = (...notices: Array<string | null | undefined>) => {
  const kept = [...new Set(notices.filter((notice): notice is string => !!notice))];
  return kept.length ? clip(kept.join(' ')) : null;
};

/** Decimal gigabytes, as disks are sold. */
export function formatGb(bytes: number): string {
  return `${(Math.max(0, bytes) / 1e9).toFixed(1)} GB`;
}

const sourceKey = (request: PullJobRequest) =>
  request.source === 'hf' ? `hf:${request.repo.toLowerCase()}:${request.buildId}` : `library:${request.ref}`;

const sourceName = (request: PullJobRequest) => (request.source === 'hf' ? request.repo : request.ref);

const reviewedModel = (build: HubBuild) => curatedLibrary(build)?.digest ?? build.weights[0]?.sha256 ?? '';

const PINNED = ['template', 'params', 'license', 'projector', 'draft'] as const;

/** True when the approved digests are exactly the build's weights and pinned layers. */
export function layersMatch(approved: PullApprovedLayers, build: HubBuild): boolean {
  const pins = curatedPins(build);
  if (!pins || approved.model !== reviewedModel(build)) return false;
  return PINNED.every(kind => (approved[kind] ?? null) === (pins[kind] ?? null));
}

/** The repo part of `hf.co/<repo>:<tag>` or `huggingface.co/<repo>:<tag>`. */
const refRepo = (ref: string) => ref.replace(/^(?:hf\.co|huggingface\.co)\//, '').replace(/:[^/]*$/, '');

const GATED_NOTICE =
  'Hugging Face shows this file only to accounts with access, so b4m-host checked it after the download.';
const PRIVATE_NOTICE =
  'b4m-host cannot read this repo without access, so the check after the download is the only check.';
const STALE_NOTICE =
  'Stopped for over an hour: if Ollama restarted meanwhile, it may have dropped the partial download and start over.';

function refusalFor(failure: ApprovalFailure, request: PullJobRequest, hostName: string): Refusal {
  const name = sourceName(request);
  const changed = `${name} changed since you reviewed it, so nothing was downloaded. Review it again.`;
  switch (failure.reason) {
    case 'not-listed':
      return refuse(failure.reason, `${name} is not the curated build you reviewed, so nothing was downloaded.`);
    case 'build-missing':
      return refuse(failure.reason, `${request.source === 'hf' ? request.buildId : name} is gone. ${changed}`);
    case 'changed':
      return refuse(failure.reason, changed);
    case 'abliterated':
      return refuse(failure.reason, `${name} is an abliterated build and is never offered as curated.`);
    case 'license-changed':
      return refuse(failure.reason, `The license of ${name} changed since you reviewed it, so nothing was downloaded.`);
    case 'license-required':
      return refuse(failure.reason, `${name} has a license you must accept before it downloads.`);
    case 'access-required':
      return refuse(
        failure.reason,
        `${name} is gated: confirm that ${hostName}'s Ollama key is added to a Hugging Face account with access.`
      );
    case 'unverified':
      return refuse(failure.reason, `The registry could not show which file Ollama would get for ${name}. ${changed}`);
    case 'blocked':
      return refuse(failure.reason, `Ollama cannot download ${name} as reviewed (${failure.block}).`);
    case 'runtime-unreachable':
      return refuse(failure.reason, `Ollama on ${hostName} is not reachable: ${clip(failure.error ?? 'no answer')}`);
    case 'runtime-too-old':
      return refuse(failure.reason, `${failure.blocked}; Ollama on ${hostName} is ${failure.actual ?? 'unknown'}.`);
    case 'layers-no-source':
    case 'layers-not-served':
    case 'layers-changed':
      return refuse(
        failure.reason,
        `The registry no longer serves ${name} as you reviewed it, so nothing was downloaded.`
      );
    case 'cancelled':
      return refuse(failure.reason, 'Cancelled.');
  }
}

/**
 * Pull jobs the host runs itself, so a client that disconnects or quits changes nothing. Every job re-checks its
 * approval through the shared checks in local-models before Ollama is asked, and the installed weights after.
 */
export class JobManager {
  #jobs = new Map<string, Entry>();
  #admission: Promise<unknown> = Promise.resolve();
  #closed = false;
  readonly #o: Required<
    Pick<
      JobManagerOptions,
      | 'floorBytes'
      | 'progressEveryMs'
      | 'saveEveryMs'
      | 'maxActive'
      | 'maxJobs'
      | 'maxKept'
      | 'inspectRetryMs'
      | 'verifyTimeoutMs'
      | 'staleAfterMs'
    >
  > &
    JobManagerOptions;

  constructor(options: JobManagerOptions) {
    this.#o = {
      floorBytes: DEFAULT_FLOOR_BYTES,
      progressEveryMs: 500,
      saveEveryMs: 5_000,
      maxActive: 4,
      maxJobs: DEFAULT_MAX_JOBS,
      maxKept: DEFAULT_MAX_KEPT,
      inspectRetryMs: [1_000, 3_000],
      verifyTimeoutMs: 40_000,
      staleAfterMs: 60 * 60_000,
      ...options,
    };
  }

  #now(): string {
    return (this.#o.now?.() ?? new Date()).toISOString();
  }

  /**
   * Reads saved jobs. One stopped while its download was being checked is checked again now, since that downloads
   * nothing; any other that was running becomes `interrupted` and waits for Resume.
   */
  async load(): Promise<void> {
    const recheck: Entry[] = [];
    for (const record of await this.#o.store.loadAll()) {
      const { job } = record;
      const entry = this.#entry(
        {
          ...job,
          error: job.error && { ...job.error, message: clip(job.error.message) },
          notice: job.notice && clip(job.notice),
        },
        record.request,
        record.run ?? { pulled: false, afterOnly: false }
      );
      if (entry.job.state === 'verifying' && entry.run.pulled) recheck.push(entry);
      else if (isActive(entry.job.state)) {
        entry.job = { ...entry.job, state: 'interrupted', updatedAt: this.#now() };
        await this.#persist(entry);
      }
      this.#jobs.set(entry.job.id, entry);
    }
    await this.#prune();
    for (const entry of recheck) this.#start(entry);
  }

  #entry(job: PullJob, request: PullJobRequest, run: RunState): Entry {
    return {
      job,
      request,
      run,
      controller: null,
      stop: null,
      task: null,
      starting: null,
      plan: null,
      verifying: false,
      spaceRechecked: false,
      spaceRefusal: null,
      lastEmit: 0,
      emitTimer: null,
      lastSave: 0,
    };
  }

  list(): PullJob[] {
    return [...this.#jobs.values()].map(entry => entry.job);
  }

  get(id: string): PullJob {
    return this.#find(id).job;
  }

  #find(id: string): Entry {
    const entry = this.#jobs.get(id);
    if (!entry) throw new HttpError(404, 'job-not-found', 'No such job.');
    return entry;
  }

  /** Whether an active job is pulling `name`, under any spelling Ollama lists it by. */
  busy(name: string): PullJob | null {
    const key = ollamaModelKey(name);
    for (const { job } of this.#jobs.values())
      if (isActive(job.state) && ollamaRefAliases(job.ref).includes(key)) return job;
    return null;
  }

  /** Another unfinished job that pulls into the same Ollama tag. */
  #tagHolder(ref: string, self: Entry | null): PullJob | null {
    const key = ollamaModelKey(ref);
    for (const entry of this.#jobs.values()) {
      if (entry !== self && !isFinal(entry.job.state) && ollamaModelKey(entry.job.ref) === key) return entry.job;
    }
    return null;
  }

  #requireTagFree(ref: string, self: Entry | null): void {
    const holder = this.#tagHolder(ref, self);
    if (holder) {
      const hint = isActive(holder.state) ? 'is already downloading' : 'holds';
      throw new HttpError(409, 'job-exists', `Job ${holder.id} ${hint} ${ref}; Ollama has one copy per tag.`);
    }
  }

  /** Removes an installed model unless a job is pulling it. */
  async removeModel(name: string, actor: PullJobActor): Promise<void> {
    const running = this.busy(name);
    if (running) throw new HttpError(409, 'model-busy', `Job ${running.id} is downloading ${name}; cancel it first.`);
    try {
      await this.#o.runtime.remove(name);
    } catch (error) {
      if (error instanceof ModelNotFoundError) throw new HttpError(404, 'model-not-found', `Ollama has no ${name}.`);
      throw error;
    }
    this.#o.audit({ event: 'remove', ref: name, device: actor.device, login: actor.user, via: actor.via });
  }

  /** Admission runs one request at a time, so a second request sees the first one's reservation. */
  #admit<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#admission.then(task, task);
    this.#admission = next.catch(() => undefined);
    return next;
  }

  #claim(entry: Entry): () => void {
    let release = () => {};
    entry.starting = new Promise<void>(resolve => (release = resolve));
    return () => {
      entry.starting = null;
      release();
    };
  }

  /** A create or resume that a cancel, dismiss or shutdown overtook while it awaited. */
  #overtaken(entry: Entry): boolean {
    return entry.stop === 'cancel' || this.#jobs.get(entry.job.id) !== entry || this.#closed;
  }

  #audit(entry: Entry, event: AuditEntry['event'], actor: PullJobActor, detail?: string | null): void {
    const { request, job } = entry;
    this.#o.audit({
      event,
      job: job.id,
      ref: job.ref,
      revision: request.source === 'hf' ? request.revision : request.manifestDigest,
      sha256: request.source === 'hf' ? request.sha256 : request.curated.layers.model,
      licensesAccepted: request.licenseAccepted ? request.licenses : [],
      device: actor.device,
      login: actor.user,
      via: actor.via,
      detail: detail ?? null,
    });
  }

  #spaceNotice(): string {
    return `b4m-host could not read the free space on ${this.#o.hostName}, so it did not check that the model fits.`;
  }

  async #room(sizeBytes: number, partialBytes: number, except: string | null): Promise<Room> {
    const free = await this.#o.freeBytes().catch(() => null);
    if (free === null) return { ok: true, unknown: true };
    const others = [...this.#jobs.values()].filter(entry => entry.job.id !== except && isActive(entry.job.state));
    const reserved = others.reduce((sum, { job }) => sum + Math.max(0, job.sizeBytes - job.progress.completedBytes), 0);
    const need = Math.max(0, sizeBytes - partialBytes);
    if (free - reserved - need >= this.#o.floorBytes) return { ok: true, unknown: false };
    const count = others.length;
    const held = count
      ? ` and ${formatGb(reserved)} already reserved by ${count} other download${count === 1 ? '' : 's'}`
      : '';
    return {
      ok: false,
      message:
        `Needs ${formatGb(need)} on ${this.#o.hostName}; ${formatGb(free)} free${held}, ` +
        `and ${formatGb(this.#o.floorBytes)} is kept free.`,
    };
  }

  #refuseSpace(message: string, ref: string, job: string | null, actor: PullJobActor): never {
    this.#o.audit({
      event: 'admission-refused',
      job,
      ref,
      device: actor.device,
      login: actor.user,
      via: actor.via,
      detail: message,
    });
    throw new HttpError(507, 'insufficient-space', message);
  }

  #requireRoom(adding: boolean): void {
    if (this.#closed) throw new HttpError(503, 'shutting-down', 'b4m-host is stopping.');
    const entries = [...this.#jobs.values()];
    const active = entries.filter(entry => isActive(entry.job.state)).length;
    if (active >= this.#o.maxActive) {
      throw new HttpError(429, 'too-many-jobs', `${active} downloads are already running; wait for one to finish.`);
    }
    const open = entries.filter(entry => !isFinal(entry.job.state)).length;
    if (adding && open >= this.#o.maxJobs) {
      throw new HttpError(
        429,
        'too-many-jobs',
        `${open} downloads are running, paused or interrupted; resume or cancel one first.`
      );
    }
  }

  /** Starts a pull from what the user approved; nothing downloads until its checks pass. */
  create(request: PullJobRequest, actor: PullJobActor): Promise<PullJob> {
    return this.#admit(async () => {
      if (this.#closed) throw new HttpError(503, 'shutting-down', 'b4m-host is stopping.');
      const key = sourceKey(request);
      const existing = [...this.#jobs.values()].find(
        entry => !isFinal(entry.job.state) && sourceKey(entry.request) === key
      );
      if (existing) {
        const hint = isActive(existing.job.state) ? 'is already downloading it' : 'holds it; resume that job';
        throw new HttpError(409, 'job-exists', `Job ${existing.job.id} ${hint}.`);
      }
      this.#requireTagFree(request.ref, null);
      this.#requireRoom(true);
      const room = await this.#room(request.sizeBytes, 0, null);
      if (!room.ok) this.#refuseSpace(room.message, request.ref, null, actor);
      this.#requireRoom(true);
      const now = this.#now();
      const job: PullJob = {
        id: randomUUID(),
        state: 'queued',
        source: request.source,
        repo: sourceName(request),
        buildId: request.source === 'hf' ? request.buildId : request.curated.buildId,
        ref: request.ref,
        sizeBytes: request.sizeBytes,
        progress: { status: 'queued', completedBytes: 0, totalBytes: null },
        startedBy: actor,
        cancelledBy: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        error: null,
        notice: room.unknown ? this.#spaceNotice() : null,
      };
      const entry = this.#entry(job, request, { pulled: false, afterOnly: false });
      this.#jobs.set(job.id, entry);
      const release = this.#claim(entry);
      try {
        await this.#persist(entry);
        this.#audit(entry, 'create', actor);
        this.#emit(entry, true);
        this.#start(entry);
      } finally {
        release();
      }
      await this.#prune();
      return entry.job;
    });
  }

  /** Stops a job for good; Ollama keeps the partial blobs until its own pruning. */
  async cancel(id: string, actor: PullJobActor): Promise<PullJob> {
    const entry = this.#find(id);
    const { state } = entry.job;
    if (isFinal(state)) throw new HttpError(409, 'job-finished', `The job already ended (${state}).`);
    if (state === 'verifying') {
      throw new HttpError(409, 'job-verifying', 'The download finished and is being checked; it ends in a moment.');
    }
    this.#audit(entry, 'cancel', actor);
    entry.job = { ...entry.job, cancelledBy: actor };
    if (entry.starting) {
      entry.stop = 'cancel';
      await entry.starting;
    }
    if (isFinal(entry.job.state) || entry.job.state === 'verifying' || this.#jobs.get(id) !== entry) return entry.job;
    if (!entry.task) {
      await this.#finish(entry, 'cancelled');
      return entry.job;
    }
    await this.#stop(entry, 'cancel');
    return entry.job;
  }

  /** Stops holding the pull; Resume re-checks and pulls again, and Ollama reuses what it already has. */
  async pause(id: string, actor: PullJobActor): Promise<PullJob> {
    const entry = this.#find(id);
    const { state } = entry.job;
    if (state === 'verifying') {
      throw new HttpError(409, 'job-verifying', 'The download finished and is being checked; it ends in a moment.');
    }
    if (!isActive(state) || !entry.task) throw new HttpError(409, 'job-not-running', `The job is ${state}.`);
    this.#audit(entry, 'pause', actor);
    await this.#stop(entry, 'pause');
    return entry.job;
  }

  async #stop(entry: Entry, reason: StopReason): Promise<void> {
    entry.stop = reason;
    entry.controller?.abort();
    const task = entry.task;
    if (!task) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([task, new Promise(resolve => (timer = setTimeout(resolve, STOP_WAIT_MS)))]);
    clearTimeout(timer);
  }

  /** Runs every check and admission again, then pulls the same build; a finished pull only gets its check. */
  resume(id: string, actor: PullJobActor): Promise<PullJob> {
    return this.#admit(async () => {
      const entry = this.#find(id);
      const { state } = entry.job;
      if ((state !== 'paused' && state !== 'interrupted') || entry.task || entry.starting) {
        throw new HttpError(
          409,
          'job-not-resumable',
          `Only a paused or interrupted job resumes; this one is ${state}.`
        );
      }
      this.#requireRoom(false);
      this.#requireTagFree(entry.job.ref, entry);
      const release = this.#claim(entry);
      try {
        const stale = Date.now() - Date.parse(entry.job.updatedAt) > this.#o.staleAfterMs;
        let spaceNotice: string | null = null;
        if (!entry.run.pulled) {
          // Past `staleAfterMs` Ollama may have dropped the partial download, so it is not credited.
          const partial = stale ? 0 : entry.job.progress.completedBytes;
          const room = await this.#room(entry.job.sizeBytes, partial, entry.job.id);
          if (this.#overtaken(entry)) return entry.job;
          if (!room.ok) this.#refuseSpace(room.message, entry.job.ref, entry.job.id, actor);
          if (room.unknown) spaceNotice = this.#spaceNotice();
        }
        this.#audit(entry, 'resume', actor);
        await this.#set(entry, {
          state: 'queued',
          notice: joinNotices(stale && !entry.run.pulled ? STALE_NOTICE : null, spaceNotice),
          error: null,
          cancelledBy: null,
          progress: { ...entry.job.progress, status: 'queued' },
        });
        this.#start(entry);
        return entry.job;
      } finally {
        release();
      }
    });
  }

  /** Forgets a finished job. */
  async dismiss(id: string, actor: PullJobActor): Promise<void> {
    const entry = this.#find(id);
    if (!isFinal(entry.job.state) || entry.starting || entry.task) {
      throw new HttpError(409, 'job-not-finished', `Cancel the job first; it is ${entry.job.state}.`);
    }
    this.#audit(entry, 'dismiss', actor);
    await this.#drop(entry);
  }

  async #drop(entry: Entry): Promise<void> {
    if (entry.emitTimer) clearTimeout(entry.emitTimer);
    this.#jobs.delete(entry.job.id);
    await this.#o.store.remove(entry.job.id).catch(error => this.#o.log(`removing job file: ${errorText(error)}`));
    this.#o.onDismissed(entry.job.id);
  }

  async #prune(): Promise<void> {
    const finished = [...this.#jobs.values()]
      .filter(entry => isFinal(entry.job.state) && !entry.task)
      .sort((a, b) => a.job.updatedAt.localeCompare(b.job.updatedAt));
    for (const entry of finished.slice(0, Math.max(0, finished.length - this.#o.maxKept))) await this.#drop(entry);
  }

  /**
   * Stops every running pull; each becomes `interrupted`, as after a crash. A check of finished download gets up
   * to `verifyTimeoutMs` to end; one still running stays `verifying` on disk, so the next start checks it again.
   */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      [...this.#jobs.values()].map(entry => {
        if (!entry.task) return undefined;
        if (entry.verifying) return this.#wait(entry.task, this.#o.verifyTimeoutMs);
        return this.#stop(entry, 'shutdown');
      })
    );
    for (const entry of this.#jobs.values()) if (entry.emitTimer) clearTimeout(entry.emitTimer);
  }

  async #wait(task: Promise<void>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([task, new Promise(resolve => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
  }

  #start(entry: Entry): void {
    const { state } = entry.job;
    const runnable = state === 'queued' || (state === 'verifying' && entry.run.pulled);
    if (!runnable || entry.task || entry.stop === 'cancel' || this.#jobs.get(entry.job.id) !== entry) return;
    if (this.#closed && state !== 'verifying') return;
    entry.stop = null;
    entry.controller = new AbortController();
    entry.task = this.#run(entry, entry.controller.signal).finally(() => {
      entry.task = null;
      entry.controller = null;
    });
  }

  async #run(entry: Entry, signal: AbortSignal): Promise<void> {
    if (entry.run.pulled) {
      const plan = this.#storedPlan(entry);
      if (!plan.ok) return this.#fail(entry, plan.code, plan.message);
      return this.#verifyStep(entry, plan);
    }
    let phase: 'checking' | 'downloading' = 'checking';
    try {
      await this.#set(entry, { state: 'checking', progress: { ...entry.job.progress, status: 'checking' } });
      const plan = await this.#check(entry.request, signal);
      if (signal.aborted) return await this.#stopped(entry);
      if (!plan.ok) {
        this.#audit(entry, 'check-failed', entry.job.startedBy, plan.message);
        return await this.#fail(entry, plan.code, plan.message);
      }
      entry.plan = plan;
      entry.run = { ...entry.run, afterOnly: plan.afterOnly };
      // Computed once and saved before the first pull: after a pull, the tag is there whoever made it.
      if (entry.run.hadTag === undefined) entry.run = { ...entry.run, hadTag: await this.#hasTag(plan.ref) };
      if (signal.aborted) return await this.#stopped(entry);
      const holder = this.#tagHolder(plan.ref, entry);
      if (holder) {
        return await this.#fail(entry, 'job-exists', `Job ${holder.id} is already getting ${plan.ref}.`);
      }
      phase = 'downloading';
      await this.#set(entry, {
        state: 'downloading',
        ref: plan.ref,
        notice: joinNotices(entry.job.notice, plan.notice),
        progress: { ...entry.job.progress, status: 'downloading' },
      });
      await this.#o.runtime.pull(plan.ref, {
        signal,
        runner: plan.runner,
        idleTimeoutMs: this.#o.pullIdleTimeoutMs,
        onProgress: progress => this.#progress(entry, progress),
      });
      if (signal.aborted) return await this.#stopped(entry);
      entry.controller = null;
      entry.run = { ...entry.run, pulled: true };
      await this.#verifyStep(entry, plan);
    } catch (error) {
      if (signal.aborted) return await this.#stopped(entry);
      const message =
        phase === 'checking'
          ? `Could not check ${sourceName(entry.request)} against what you reviewed: ${errorText(error)}`
          : `Ollama could not download ${entry.job.ref}: ${errorText(error)}`;
      if (phase === 'checking') this.#audit(entry, 'check-failed', entry.job.startedBy, message);
      await this.#fail(entry, phase === 'checking' ? 'check-error' : 'pull-failed', message);
    }
  }

  async #verifyStep(entry: Entry, plan: Plan): Promise<void> {
    entry.verifying = true;
    try {
      await this.#set(entry, { state: 'verifying', progress: { ...entry.job.progress, status: 'verifying' } });
      const failure = await this.#verify(plan, entry.run.hadTag ?? null).catch((error: unknown) => ({
        code: 'unverified',
        message: `b4m-host could not check ${plan.ref} after downloading it: ${errorText(error)}`,
      }));
      if (failure) {
        this.#audit(
          entry,
          failure.code === 'digest-mismatch' ? 'digest-failed' : 'check-failed',
          entry.job.startedBy,
          failure.message
        );
        return await this.#fail(entry, failure.code, failure.message);
      }
      this.#audit(entry, 'done', entry.job.startedBy);
      await this.#finish(entry, 'done');
    } finally {
      entry.verifying = false;
    }
  }

  /** The plan of a job whose pull already finished, rebuilt from what was saved. */
  #storedPlan(entry: Entry): Plan | Refusal {
    const { request } = entry;
    const base = { ok: true as const, ref: entry.job.ref, notice: null, afterOnly: entry.run.afterOnly, hidden: false };
    if (request.source === 'hf' && !request.curated)
      return { ...base, verify: { kind: 'blob', sha256: request.sha256 } };
    if (!request.curated) return refuse('not-listed', `${request.ref} is not a curated build.`);
    const curated = this.#curated(request.curated);
    return curated.ok ? { ...base, verify: { kind: 'curated', build: curated.build } } : curated;
  }

  async #stopped(entry: Entry): Promise<void> {
    const reason = entry.stop ?? 'shutdown';
    if (reason === 'space') return this.#spaceStopped(entry);
    const race = reason === 'shutdown' ? null : await this.#settleRace(entry);
    if (reason === 'cancel') {
      return this.#finish(entry, 'cancelled', null, joinNotices(entry.job.notice, race));
    }
    await this.#set(entry, {
      state: reason === 'pause' ? 'paused' : 'interrupted',
      notice: joinNotices(entry.job.notice, race),
      progress: { ...entry.job.progress, status: reason === 'pause' ? 'paused' : 'interrupted' },
    });
  }

  /**
   * A stop can lose the race with the end of the download. When the tag is new and Ollama now lists it, its
   * weights are checked: kept on a match, removed otherwise. Returns what the job should say about it.
   */
  async #settleRace(entry: Entry): Promise<string | null> {
    const { plan } = entry;
    if (!plan || entry.run.hadTag !== false || (await this.#hasTag(plan.ref)) !== true) return null;
    const failure = await this.#verify(plan, false).catch((error: unknown) => ({
      code: 'unverified',
      message: `b4m-host could not check ${plan.ref}: ${errorText(error)}`,
    }));
    if (failure) return `The download finished before it stopped. ${failure.message}`;
    entry.run = { ...entry.run, pulled: true };
    return `The download finished before it stopped; ${plan.ref} matches what you approved and is installed.`;
  }

  async #spaceStopped(entry: Entry): Promise<void> {
    const message = entry.spaceRefusal ?? 'The model is larger than the free space on the host.';
    const { plan } = entry;
    if (plan && entry.run.hadTag === false && (await this.#hasTag(plan.ref)) === true) {
      await this.#o.runtime.remove(plan.ref).catch(error => this.#o.log(`removing ${plan.ref}: ${errorText(error)}`));
    }
    this.#o.audit({ event: 'admission-refused', job: entry.job.id, ref: entry.job.ref, detail: message });
    await this.#fail(
      entry,
      'insufficient-space',
      `Ollama reported the model is ${formatGb(entry.job.sizeBytes)}, more than fits. ${message} The download stopped.`
    );
  }

  #fail(entry: Entry, code: string, message: string): Promise<void> {
    return this.#finish(entry, 'failed', { code, message: clip(message) });
  }

  async #finish(
    entry: Entry,
    state: 'done' | 'failed' | 'cancelled',
    error: PullJob['error'] = null,
    notice: string | null = entry.job.notice
  ): Promise<void> {
    await this.#set(entry, {
      state,
      error,
      notice,
      finishedAt: this.#now(),
      progress: { ...entry.job.progress, status: state },
    });
  }

  async #set(entry: Entry, patch: Partial<PullJob>): Promise<void> {
    entry.job = { ...entry.job, ...patch, updatedAt: this.#now() };
    this.#emit(entry, true);
    await this.#persist(entry);
  }

  #progress(entry: Entry, progress: PullProgress): void {
    entry.job = {
      ...entry.job,
      progress: {
        status: clip(progress.status, L_STATUS - 3),
        completedBytes: Math.max(0, Math.round(progress.completedBytes)),
        totalBytes: progress.totalBytes === null ? null : Math.max(0, Math.round(progress.totalBytes)),
      },
      updatedAt: this.#now(),
    };
    if (entry.plan?.hidden && !entry.spaceRechecked && entry.job.progress.totalBytes) {
      entry.spaceRechecked = true;
      void this.#recheckSpace(entry, entry.job.progress.totalBytes);
    }
    if (Date.now() - entry.lastSave >= this.#o.saveEveryMs) void this.#persist(entry);
    this.#emit(entry, false);
  }

  /** A hidden repo's size was the client's word; the first size Ollama reports goes through admission again. */
  async #recheckSpace(entry: Entry, totalBytes: number): Promise<void> {
    entry.job = { ...entry.job, sizeBytes: totalBytes };
    const room = await this.#room(totalBytes, entry.job.progress.completedBytes, entry.job.id);
    if (room.ok || !entry.controller || entry.stop) return;
    entry.spaceRefusal = room.message;
    entry.stop = 'space';
    entry.controller.abort();
  }

  #persist(entry: Entry): Promise<void> {
    entry.lastSave = Date.now();
    return this.#o.store
      .save({ job: entry.job, request: entry.request, run: entry.run })
      .catch(error => this.#o.log(`saving job ${entry.job.id}: ${errorText(error)}`));
  }

  /** State changes go out at once; progress at most once per `progressEveryMs`, the latest winning. */
  #emit(entry: Entry, force: boolean): void {
    if (entry.emitTimer) {
      if (!force) return;
      clearTimeout(entry.emitTimer);
      entry.emitTimer = null;
    }
    const wait = this.#o.progressEveryMs - (Date.now() - entry.lastEmit);
    if (force || wait <= 0) {
      entry.lastEmit = Date.now();
      this.#o.onJob(entry.job);
      return;
    }
    entry.emitTimer = setTimeout(() => {
      entry.emitTimer = null;
      entry.lastEmit = Date.now();
      if (this.#jobs.get(entry.job.id) === entry) this.#o.onJob(entry.job);
    }, wait);
    entry.emitTimer.unref();
  }

  #approvalDeps(signal: AbortSignal): ApprovalDeps {
    return {
      hub: () => this.#o.hub(),
      libraryLayers: this.#o.libraryLayers,
      health: () => this.#o.runtime.health(),
      signal,
    };
  }

  #curated(
    approved: NonNullable<Extract<PullJobRequest, { source: 'hf' }>['curated']>
  ): { ok: true; entry: HubEntry; build: HubBuild } | Refusal {
    const manifest = this.#o.curated();
    const entry = manifest.entries.find(candidate => candidate.id === approved.entryId);
    const build = entry?.builds.find(candidate => candidate.id === approved.buildId);
    if (!entry || !build) {
      return refuse(
        'not-listed',
        `${approved.entryId} (${approved.buildId}) is not in this b4m-host's curated list; upgrade b4m-host to a version that lists it.`
      );
    }
    if (!isCuratedListable(entry, manifest)) {
      return refuse('not-listed', `${entry.name} is no longer offered as curated, so nothing was downloaded.`);
    }
    if (!layersMatch(approved.layers, build)) {
      return refuse(
        'layers-changed',
        `The layers you reviewed for ${entry.name} are not the ones this b4m-host's curated list pins, so nothing was downloaded.`
      );
    }
    return { ok: true, entry, build };
  }

  async #check(request: PullJobRequest, signal: AbortSignal): Promise<Plan | Refusal> {
    const curated = request.curated ? this.#curated(request.curated) : null;
    if (curated && !curated.ok) return curated;
    const reviewed = curated && { entry: curated.entry, build: curated.build };
    const deps = this.#approvalDeps(signal);

    if (request.source === 'library') {
      if (!reviewed) return refuse('not-listed', `${request.ref} is not a curated build.`);
      if (licensesChanged(request.licenses, [reviewed.entry.license.id])) {
        return refuse('license-changed', `The license of ${request.ref} changed since you reviewed it.`);
      }
      const checked = await checkApproval(
        {
          source: 'library',
          ref: request.ref,
          buildId: reviewed.build.id,
          manifestDigest: request.manifestDigest,
          sizeBytes: request.sizeBytes,
          licenseAccepted: request.licenseAccepted,
          curated: reviewed,
        },
        deps
      );
      if (!checked.ok) return refusalFor(checked, request, this.#o.hostName);
      return {
        ok: true,
        ref: checked.ref,
        runner: curatedRunner(reviewed.build),
        verify: { kind: 'curated', build: reviewed.build },
        notice: null,
        afterOnly: false,
        hidden: false,
      };
    }

    if (!sameRepo(refRepo(request.ref), request.repo)) {
      return refuse('invalid-ref', `${request.ref} does not name ${request.repo}.`);
    }
    if (reviewed && reviewed.build.weights[0]?.sha256 !== request.sha256) {
      return refuse(
        'layers-changed',
        `The file you reviewed is not the one the curated list pins for ${request.repo}.`
      );
    }
    // Keeps the Hub's answer for the repo itself, so the license and checksum compare with what the checks read,
    // and the error of that one read, the only one that may mean a private repo.
    const seen: { detail: HubModelDetail | null; repoError: unknown } = { detail: null, repoError: null };
    const base = this.#o.hub();
    const hub: PullCheckHub = {
      getModel: async (repo, options) => {
        const own = sameRepo(repo, request.repo);
        try {
          const detail = await base.getModel(repo, options);
          if (own) seen.detail = detail;
          return detail;
        } catch (error) {
          if (own) seen.repoError = error;
          throw error;
        }
      },
      verifyOllamaRef: (detail, build, options) => base.verifyOllamaRef(detail, build, options),
      ollamaLayers: (repo, tag, options) => base.ollamaLayers(repo, tag, options),
    };
    let checked;
    try {
      checked = await checkApproval(
        {
          source: 'hf',
          repo: request.repo,
          buildId: request.buildId,
          revision: request.revision,
          sizeBytes: request.sizeBytes,
          licenseAccepted: request.licenseAccepted,
          accessConfirmed: request.accessConfirmed,
          curated: reviewed,
        },
        { ...deps, hub: () => hub, checkAfterPull: true }
      );
    } catch (error) {
      // The Hub answers a private repo and a missing one alike to a reader without a token.
      const hidden = error === seen.repoError && error instanceof ModelNotFoundError;
      if (!hidden || !request.accessConfirmed || reviewed) throw error;
      const health = await this.#o.runtime.health();
      if (!health.ok) {
        return refusalFor({ ok: false, reason: 'runtime-unreachable', error: health.error }, request, this.#o.hostName);
      }
      return {
        ok: true,
        ref: ollamaPullRef(request.ref.replace(/^huggingface\.co\//, 'hf.co/'), true),
        verify: { kind: 'blob', sha256: request.sha256 },
        notice: PRIVATE_NOTICE,
        afterOnly: true,
        hidden: true,
      };
    }
    if (!checked.ok) return refusalFor(checked, request, this.#o.hostName);
    const { detail } = seen;
    const changed = refuse('changed', `${request.repo} changed since you reviewed it, so nothing was downloaded.`);
    if (detail && licensesChanged(request.licenses, detail.licenses)) {
      return refuse('license-changed', `The license of ${request.repo} changed since you reviewed it.`);
    }
    const sha = detail?.builds.find(build => build.id === request.buildId)?.files[0]?.sha256 ?? null;
    if (sha !== null && sha !== request.sha256) return changed;
    const unproven = checked.verified === false;
    if (!unproven && ollamaModelKey(checked.ref) !== ollamaModelKey(request.ref)) return changed;
    return {
      ok: true,
      ref: checked.ref,
      runner: reviewed ? curatedRunner(reviewed.build) : undefined,
      verify: reviewed ? { kind: 'curated', build: reviewed.build } : { kind: 'blob', sha256: request.sha256 },
      notice: unproven ? GATED_NOTICE : null,
      afterOnly: unproven,
      hidden: false,
    };
  }

  async #hasTag(ref: string): Promise<boolean | null> {
    try {
      const aliases = ollamaRefAliases(ref);
      return (await this.#o.runtime.list()).some(model => aliases.includes(ollamaModelKey(model.name)));
    } catch {
      return null;
    }
  }

  async #verify(plan: Plan, hadTag: boolean | null): Promise<{ code: string; message: string } | null> {
    const { ref } = plan;
    const deadline = Date.now() + this.#o.verifyTimeoutMs;
    let inspection: ModelInspection | null = null;
    for (let attempt = 0; !inspection; attempt++) {
      try {
        const timeoutMs = Math.max(1_000, Math.min(CHECK_TIMEOUT_MS, deadline - Date.now()));
        inspection = await this.#o.runtime.inspect(ref, { tags: false, timeoutMs });
      } catch (error) {
        if (error instanceof ModelNotFoundError) {
          return { code: 'missing', message: `Ollama finished downloading ${ref} but does not list it.` };
        }
        const pause = this.#o.inspectRetryMs[attempt];
        if (pause === undefined || Date.now() + pause >= deadline) return this.#unverified(plan, hadTag, error);
        await new Promise(resolve => setTimeout(resolve, pause));
      }
    }
    const removal = { hadTag, remove: () => this.#o.runtime.remove(ref) };
    const { verify } = plan;
    const checked =
      verify.kind === 'curated'
        ? await checkInstalledDigest(inspection, verify.build, removal)
        : await checkInstalledBlob(inspection, verify.sha256, removal);
    if (checked.ok) return null;
    const expected = verify.kind === 'curated' ? reviewedModel(verify.build) : verify.sha256;
    const got = inspection.contents?.modelBlob ?? null;
    const head =
      got === expected
        ? `What Ollama installed for ${ref} does not match the build you approved`
        : `The downloaded file does not match the one you approved (expected ${expected.slice(0, 8)}, got ${got ? got.slice(0, 8) : 'none'})`;
    if (checked.outcome === 'removed') return { code: 'digest-mismatch', message: `${head}, so it was removed.` };
    if (checked.outcome === 'remove-failed') {
      return { code: 'digest-mismatch', message: `${head}, and removing it failed. Remove ${ref} by hand.` };
    }
    const why =
      checked.outcome === 'left-in-place' && checked.hadTag
        ? `${ref} was installed before this download, so the previous model was replaced and is left in place`
        : `b4m-host could not tell whether ${ref} was installed before, so it is left in place`;
    return { code: 'digest-mismatch', message: `${head}. ${why}; remove it unless you trust it.` };
  }

  /** Ollama could not describe the model. When nothing else proved the file and the tag is new, it is removed. */
  async #unverified(plan: Plan, hadTag: boolean | null, error: unknown): Promise<{ code: string; message: string }> {
    const { ref } = plan;
    const head = `Ollama could not describe ${ref} after downloading it (${errorText(error)})`;
    if (!plan.afterOnly || hadTag !== false) {
      return {
        code: 'unverified',
        message: `${head}, so it was not checked against what you approved. It is still installed; remove it unless you trust it.`,
      };
    }
    try {
      await this.#o.runtime.remove(ref);
    } catch (removeError) {
      return {
        code: 'unverified',
        message: `${head}, and nothing else proved it is the file you approved. Removing it failed (${errorText(removeError)}); remove ${ref} by hand.`,
      };
    }
    return {
      code: 'unverified',
      message: `${head}, and nothing else proved it is the file you approved, so it was removed.`,
    };
  }
}
