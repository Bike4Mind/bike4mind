import {
  DEFAULT_OLLAMA_SERVE_START_TIMEOUT_MS,
  findOllamaBinary,
  LlamaServerRuntime,
  startOllamaServe,
} from '@bike4mind/local-models';
import type { LaunchRuntime, ModelServerLaunchSettings } from '@shared/modelServers';
import type { SecretCipher, StoreFile } from '../chat/mcp/McpServerStore';
import { findOnPath, resolveUserPath } from '../chat/tools/userPath';
import {
  adoptedHandle,
  hostProcessProbe,
  ownedEntryCount,
  readOwnedRecords,
  sameStartTime,
  writeOwnedRecords,
  type AdoptedTiming,
  type OwnedRecord,
  type ProcessProbe,
} from './adoptedServers';

/** A server process Desktop started: `ollama serve`, or a llama-server router. */
export interface ServerHandle {
  readonly pid: number;
  readonly running: boolean;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stopped: boolean }>;
  /** llama-server only: the per-process key every request needs. */
  readonly apiKey?: string;
  log(): string[];
  stop(): Promise<unknown>;
}

export interface LaunchRequest {
  runtime: LaunchRuntime;
  /** On 127.0.0.1. */
  port: number;
  settings: ModelServerLaunchSettings;
}

export interface Launchers {
  /** The program Start runs, or why there is none. */
  program(runtime: LaunchRuntime, settings: ModelServerLaunchSettings): Promise<{ path: string } | { problem: string }>;
  start(program: string, request: LaunchRequest, signal: AbortSignal): Promise<ServerHandle>;
}

/** A server Desktop started that still runs. */
export interface OwnedServer {
  runtime: LaunchRuntime;
  port: number;
  pid: number;
  /** The settings it started with. */
  settings: ModelServerLaunchSettings;
}

interface Slot {
  request: LaunchRequest;
  busy: 'starting' | 'stopping' | null;
  handle: ServerHandle | null;
  starting: AbortController | null;
}

export interface LocalServerSupervisorDeps {
  launchers?: Launchers;
  logger: { warn(message: string): void };
  /** A server Desktop started exited without being stopped, or one changed between starting, running and stopping. */
  changed(id: string): void;
  /** Lists the servers Desktop runs while they run, for `adopt`; without it nothing is listed or adopted. */
  records?: StoreFile;
  /** Seals a llama-server key in `records`; without one that works, llama-server is neither listed nor adopted. */
  cipher?: SecretCipher & { getSelectedStorageBackend?(): string };
  /** Defaults to this computer's (hostProcessProbe). */
  processes?: ProcessProbe;
  adoptedTiming?: AdoptedTiming;
}

const MAX_UNVERIFIED_LAUNCHES = 3;

const NOUN: Record<LaunchRuntime, string> = { ollama: 'Ollama', 'llama-server': 'llama-server' };

/**
 * The model servers Desktop runs on this computer, by saved server id: at most one per id, each known by its process
 * and port. The only servers it did not start in this run that it takes as its own are ones `adopt` finds it started
 * in an earlier one.
 */
export class LocalServerSupervisor {
  private readonly slots = new Map<string, Slot>();
  private readonly problems = new Map<string, string>();
  private readonly launchers: Launchers;
  private readonly processes: ProcessProbe;
  private readonly records = new Map<string, OwnedRecord>();
  private readonly unverified = new Map<string, OwnedRecord>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LocalServerSupervisorDeps) {
    this.launchers = deps.launchers ?? hostLaunchers();
    this.processes = deps.processes ?? hostProcessProbe();
  }

  /**
   * Takes back the servers an earlier run listed and did not stop, when `accepts` still wants each one: only a process
   * with the recorded pid and start time that still listens on the recorded port. Drops every other record,
   * except one whose process cannot be read (see stillRuns).
   */
  async adopt(accepts: (record: OwnedRecord) => boolean): Promise<void> {
    const file = this.deps.records;
    if (!file) return;
    let found: OwnedRecord[];
    let listedCount: number;
    try {
      const text = await file.read();
      const cipher = this.sealer();
      found = readOwnedRecords(
        text,
        cipher ? sealed => cipher.decryptString(Buffer.from(sealed, 'base64')) : undefined
      );
      listedCount = ownedEntryCount(text);
    } catch (error) {
      this.deps.logger.warn(`MODEL SERVERS: could not read the servers Desktop ran: ${String(error)}`);
      return;
    }
    const firstOfId = found.filter((record, at) => found.findIndex(other => other.id === record.id) === at);
    const candidates = firstOfId.filter(record => !this.slots.has(record.id) && accepts(record));
    let reset = false;
    const verdicts = await Promise.all(candidates.map(record => this.stillRuns(record)));
    for (const [index, record] of candidates.entries()) {
      const runs = verdicts[index];
      if (runs === null) {
        const launches = (record.unverifiedLaunches ?? 0) + 1;
        if (launches <= MAX_UNVERIFIED_LAUNCHES) {
          this.unverified.set(record.id, { ...record, unverifiedLaunches: launches });
        }
        continue;
      }
      if (!runs) continue;
      const handle = adoptedHandle(record, this.processes, this.deps.adoptedTiming);
      const slot: Slot = {
        request: { runtime: record.runtime, port: record.port, settings: record.settings },
        busy: null,
        handle,
        starting: null,
      };
      this.slots.set(record.id, slot);
      const { unverifiedLaunches, ...fresh } = record;
      this.records.set(record.id, fresh);
      if (unverifiedLaunches) reset = true;
      this.watch(record.id, slot, handle);
    }
    if (this.unverified.size > 0 || this.records.size !== listedCount || reset) await this.persist();
  }

  /**
   * Null when the probe cannot tell after a retry; the record is then kept for later launches,
   * up to three that cannot read it.
   */
  private async stillRuns(record: OwnedRecord): Promise<boolean | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!sameStartTime(await this.processes.startTime(record.pid), record.startTime)) return false;
        if (!(await this.processes.leadsGroup(record.pid))) return false;
        return await this.processes.listening(record.port).catch(() => false);
      } catch {
        if (attempt > 0) return null;
        await new Promise(done => setTimeout(done, this.deps.adoptedTiming?.probeRetryMs ?? 250));
      }
    }
  }

  /** A key is sealed only with a real keychain; Linux's basic_text backend uses a hardcoded password. */
  private sealer() {
    const { cipher } = this.deps;
    return cipher?.isEncryptionAvailable() && cipher.getSelectedStorageBackend?.() !== 'basic_text' ? cipher : null;
  }

  owned(id: string): OwnedServer | null {
    const slot = this.slots.get(id);
    const handle = slot?.handle;
    if (!slot || !handle?.running) return null;
    return { runtime: slot.request.runtime, port: slot.request.port, pid: handle.pid, settings: slot.request.settings };
  }

  busy(id: string): 'starting' | 'stopping' | null {
    return this.slots.get(id)?.busy ?? null;
  }

  /** Why the last start failed or the server stopped on its own; cleared by the next start. */
  problem(id: string): string | null {
    return this.problems.get(id) ?? null;
  }

  /** The Authorization header for a llama-server Desktop runs; null for any other server. */
  headers(id: string): Record<string, string> | null {
    const handle = this.slots.get(id)?.handle;
    return handle?.running && handle.apiKey ? { authorization: `Bearer ${handle.apiKey}` } : null;
  }

  program(
    runtime: LaunchRuntime,
    settings: ModelServerLaunchSettings
  ): Promise<{ path: string } | { problem: string }> {
    return this.launchers.program(runtime, settings);
  }

  /** Starts the server for `id`; rejects with why it could not, which `problem` keeps. */
  async start(id: string, request: LaunchRequest): Promise<void> {
    const current = this.slots.get(id);
    if (current?.busy || current?.handle?.running) throw new Error(`${NOUN[request.runtime]} is already running.`);
    this.problems.delete(id);
    const controller = new AbortController();
    const slot: Slot = { request, busy: 'starting', handle: null, starting: controller };
    this.slots.set(id, slot);
    this.deps.changed(id);
    try {
      const found = await this.launchers.program(request.runtime, request.settings);
      if ('problem' in found) throw new Error(found.problem);
      const handle = await this.launchers.start(found.path, request, controller.signal);
      if (controller.signal.aborted) {
        await handle.stop();
        throw controller.signal.reason;
      }
      slot.handle = handle;
      this.watch(id, slot, handle);
      await this.remember(id, slot, handle);
    } catch (error) {
      if (this.slots.get(id) === slot) this.slots.delete(id);
      const message = error instanceof Error ? error.message : String(error);
      if (!controller.signal.aborted) this.problems.set(id, message);
      throw new Error(message, { cause: error });
    } finally {
      if (slot.busy === 'starting') slot.busy = null;
      slot.starting = null;
      this.deps.changed(id);
    }
  }

  /** Stops the server Desktop runs for `id`, or cancels its start; nothing when it runs none. */
  async stop(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.starting?.abort(new Error('Stopped before it was ready.'));
    if (!slot.handle) return;
    slot.busy = 'stopping';
    this.deps.changed(id);
    const { handle } = slot;
    try {
      await handle.stop();
    } catch (error) {
      // A server that survived SIGKILL keeps its slot and record, so Desktop still shows it running.
      if (handle.running) {
        slot.busy = null;
        this.deps.changed(id);
        throw error;
      }
    }
    if (this.slots.get(id) === slot) this.slots.delete(id);
    await this.forget(id);
    this.deps.changed(id);
  }

  private watch(id: string, slot: Slot, handle: ServerHandle): void {
    void handle.exited.then(exit => {
      if (this.slots.get(id) !== slot) return;
      this.slots.delete(id);
      void this.forget(id);
      if (!exit.stopped) {
        const how = exit.signal ? ` (signal ${exit.signal})` : exit.code === null ? '' : ` (code ${exit.code})`;
        const last = handle.log().at(-1)?.trim();
        const problem = `${NOUN[slot.request.runtime]} stopped${how}${last ? `: ${last.slice(0, 300)}` : '.'}`;
        this.problems.set(id, problem);
        this.deps.logger.warn(`MODEL SERVERS: ${problem}`);
      }
      this.deps.changed(id);
    });
  }

  private async remember(id: string, slot: Slot, handle: ServerHandle): Promise<void> {
    // Any new start for this id supersedes a record an earlier launch could not read.
    const stale = this.unverified.delete(id);
    if (!(await this.list(id, slot, handle)) && stale) await this.persist();
  }

  /** Lists a server this run started, for `adopt`; one whose start time cannot be read is never adopted, so not listed. */
  private async list(id: string, slot: Slot, handle: ServerHandle): Promise<boolean> {
    if (!this.deps.records) return false;
    if (handle.apiKey && !this.sealer()) return false;
    const startTime = await this.processes.startTime(handle.pid).catch(() => null);
    if (!startTime || this.slots.get(id) !== slot || !handle.running) return false;
    const { runtime, port, settings } = slot.request;
    this.records.set(id, {
      id,
      runtime,
      pid: handle.pid,
      startTime,
      port,
      startedAt: new Date().toISOString(),
      settings,
      ...(handle.apiKey ? { apiKey: handle.apiKey } : {}),
    });
    await this.persist();
    return true;
  }

  private forget(id: string): Promise<void> {
    return this.records.delete(id) ? this.persist() : Promise.resolve();
  }

  /** Writes in call order, each with the list as it stood when called. */
  private persist(): Promise<void> {
    const file = this.deps.records;
    if (!file) return Promise.resolve();
    const cipher = this.sealer();
    const contents = writeOwnedRecords(
      [...[...this.unverified.values()].filter(({ id }) => !this.records.has(id)), ...this.records.values()],
      cipher ? key => cipher.encryptString(key).toString('base64') : undefined
    );
    this.writing = this.writing
      .then(() => file.write(contents))
      .catch(error =>
        this.deps.logger.warn(`MODEL SERVERS: could not list the servers Desktop runs: ${String(error)}`)
      );
    return this.writing;
  }

  /** Every server Desktop runs, before quitting. Children it misses die with the process (see processTree). */
  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.slots.keys()].map(id =>
        this.stop(id).catch(error => this.deps.logger.warn(`MODEL SERVERS: could not stop ${id}: ${String(error)}`))
      )
    );
  }
}

/**
 * On a GPU that shares system memory, lets ggml's CUDA and HIP backends allocate past the dedicated part instead of
 * failing the load. B4M_DISABLE_GPU_SPILL=1 opts out; a GGML_CUDA_ENABLE_UNIFIED_MEMORY the user set wins.
 */
export function spillEnv(env: NodeJS.ProcessEnv, unifiedMemory: boolean): NodeJS.ProcessEnv {
  if (!unifiedMemory || env.B4M_DISABLE_GPU_SPILL === '1' || env.GGML_CUDA_ENABLE_UNIFIED_MEMORY !== undefined) {
    return env;
  }
  return { ...env, GGML_CUDA_ENABLE_UNIFIED_MEMORY: '1' };
}

export interface HostLauncherOptions {
  env?: NodeJS.ProcessEnv;
  /** Whether this computer's GPU uses system memory (HardwareProfile memoryKind 'unified'); false when unknown. */
  unifiedMemory?(): Promise<boolean>;
}

/** Starts servers on this computer's own OS, finding programs on the user's login-shell PATH. */
export function hostLaunchers({ env = process.env, unifiedMemory }: HostLauncherOptions = {}): Launchers {
  return {
    async program(runtime, settings) {
      if (runtime === 'ollama') {
        const found = await findOllamaBinary({ path: await resolveUserPath() });
        return found
          ? { path: found }
          : {
              problem: 'Desktop could not find Ollama on this computer. Install it from ollama.com, then check again.',
            };
      }
      if (!settings.modelsDir) return { problem: 'Enter the folder of GGUF models for llama-server to serve.' };
      if (settings.binaryPath) return { path: settings.binaryPath };
      const found = await findOnPath('llama-server', await resolveUserPath());
      return found ? { path: found } : { problem: 'Desktop could not find llama-server on PATH. Enter its full path.' };
    },
    async start(program, request, signal) {
      const unified = (await unifiedMemory?.().catch(() => false)) ?? false;
      const childEnv = spillEnv({ ...env, PATH: await resolveUserPath() }, unified);
      const flashAttention = request.settings.flashAttention;
      if (request.runtime === 'ollama') {
        return startOllamaServe({
          binaryPath: program,
          port: request.port,
          settings: {
            kvCacheType: request.settings.kvCacheType,
            ...(flashAttention ? { flashAttention: flashAttention === 'on' } : {}),
          },
          env: childEnv,
          signal,
        });
      }
      const runtime = new LlamaServerRuntime({
        binaryPath: program,
        modelsDir: request.settings.modelsDir ?? '',
        env: childEnv,
        startTimeoutMs: DEFAULT_OLLAMA_SERVE_START_TIMEOUT_MS,
      });
      return runtime.startRouter({ port: request.port, flashAttention, signal });
    },
  };
}
