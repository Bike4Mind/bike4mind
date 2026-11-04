import { findOllamaBinary, LlamaServerRuntime, startOllamaServe } from '@bike4mind/local-models';
import type { LaunchRuntime, ModelServerLaunchSettings } from '@shared/modelServers';
import { findOnPath, resolveUserPath } from '../chat/tools/userPath';

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
}

const NOUN: Record<LaunchRuntime, string> = { ollama: 'Ollama', 'llama-server': 'llama-server' };

/**
 * The model servers Desktop runs on this computer, by saved server id: at most one per id, each known by its child
 * process and port. Nothing here adopts a server it did not start.
 */
export class LocalServerSupervisor {
  private readonly slots = new Map<string, Slot>();
  private readonly problems = new Map<string, string>();
  private readonly launchers: Launchers;

  constructor(private readonly deps: LocalServerSupervisorDeps) {
    this.launchers = deps.launchers ?? hostLaunchers();
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
      slot.handle = handle;
      void handle.exited.then(exit => {
        if (this.slots.get(id) !== slot) return;
        this.slots.delete(id);
        if (!exit.stopped) {
          const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
          const last = handle.log().at(-1)?.trim();
          const problem = `${NOUN[request.runtime]} stopped (${how})${last ? `: ${last.slice(0, 300)}` : '.'}`;
          this.problems.set(id, problem);
          this.deps.logger.warn(`MODEL SERVERS: ${problem}`);
        }
        this.deps.changed(id);
      });
    } catch (error) {
      if (this.slots.get(id) === slot) this.slots.delete(id);
      const message = error instanceof Error ? error.message : String(error);
      if (!controller.signal.aborted) this.problems.set(id, message);
      throw new Error(message, { cause: error });
    } finally {
      slot.busy = null;
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
    try {
      await slot.handle.stop();
    } finally {
      if (this.slots.get(id) === slot) this.slots.delete(id);
      this.deps.changed(id);
    }
  }

  /** Every server Desktop runs, before quitting. Children it misses die with the process (see processTree). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.slots.keys()].map(id => this.stop(id).catch(() => undefined)));
  }
}

/** Starts servers on this computer's own OS, finding programs on the user's login-shell PATH. */
export function hostLaunchers(env: NodeJS.ProcessEnv = process.env): Launchers {
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
      const childEnv = { ...env, PATH: await resolveUserPath() };
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
      });
      return runtime.startRouter({ port: request.port, flashAttention, signal });
    },
  };
}
