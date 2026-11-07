import { lmStudioModelsSchema } from '../openaiCompatible';
import type { FetchLike, OpenAICompatibleProduct } from '../types';
import { describeFailure, errorCode } from './failure';
import type { ModelServerKind } from './modelServerFile';
import { probeServer } from './probe';
import { SSH_PROBE_TIMEOUT_MS, SshConnectionError, SshForwardRefusedError, SshRefusedError, sshServerUrl } from './ssh';

/** The default ports of DEFAULT_PROBE_HOSTS in detect.ts, in the same order, with what usually listens there. */
export const SSH_DISCOVERY_PORTS: readonly { port: number; usual: string }[] = [
  { port: 11434, usual: 'Ollama' },
  { port: 1234, usual: 'LM Studio' },
  { port: 8080, usual: 'llama-server' },
  { port: 8000, usual: 'vLLM' },
];

/** The whole discovery, connection setup included; each request also has SSH_PROBE_TIMEOUT_MS. */
export const SSH_DISCOVERY_DEADLINE_MS = SSH_PROBE_TIMEOUT_MS + 10_000;

export interface SshFoundServer {
  port: number;
  kind: ModelServerKind;
  product: OpenAICompatibleProduct | null;
  version: string | null;
  models: number | null;
  latencyMs: number | null;
  /** It answered 401: an OpenAI-compatible server started with an API key, such as llama-server --api-key. */
  needsCredentials: boolean;
}

export interface SshDiscovery {
  found: SshFoundServer[];
  /** Why nothing was found, saying what to do; null when something was. */
  error: string | null;
  /** The login or host key needs the user, as SshRefusedError does; a retry will not help. */
  refused: boolean;
}

export interface SshDiscoveryOptions {
  destination: string;
  /** Probe only this far-end port instead of SSH_DISCOVERY_PORTS. Validated by the caller with parseSshPort. */
  port?: number;
  /** A fetch to the far end's loopback `port` (createSshFetch), sharing one ssh connection where ssh allows. */
  fetchFor(port: number): FetchLike;
  now(): number;
  deadlineMs?: number;
  /** Each request's own limit, counted from when it starts; SSH_PROBE_TIMEOUT_MS by default. */
  requestTimeoutMs?: number;
  /** Cancels the discovery, such as on Ctrl-C; it then rejects with the signal's reason. */
  signal?: AbortSignal;
}

type PortResult =
  | { state: 'found'; server: SshFoundServer }
  | { state: 'closed'; ambiguous: boolean }
  | { state: 'other'; message: string }
  /** `limitMs` is the limit that ran out: the whole deadline, or one request's. */
  | { state: 'timeout'; limitMs: number }
  | { state: 'failed'; error: unknown };

function sshCause(error: unknown): unknown {
  if (error instanceof SshConnectionError || error instanceof SshRefusedError) return error;
  return error instanceof Error && error.cause !== undefined ? error.cause : error;
}

/** ssh itself failed (login, host key, network), so every other port would fail the same way. */
function connectionFailure(error: unknown): boolean {
  const cause = sshCause(error);
  return (
    cause instanceof SshRefusedError ||
    (cause instanceof SshConnectionError && !(cause instanceof SshForwardRefusedError))
  );
}

/**
 * Holds every request until the first has its answer, so ssh logs in once and, where it shares connections, the
 * rest ride that master instead of each racing to become one. After a failed login, or a first request that ran
 * out its own limit (an unanswered agent prompt or key touch), the rest fail at once instead of each prompting.
 */
function firstRequestAlone(destination: string, timeoutMs: number, custom: boolean): (fetch: FetchLike) => FetchLike {
  let first: Promise<void> | null = null;
  let fatal: { error: unknown } | null = null;
  const advice = custom ? 'restart that server' : 'restart that server, or enter the port of the one you want';
  return fetch => async (input, init) => {
    if (!first) {
      const url = new URL(input);
      const target = `${url.hostname}:${url.port || '80'}`;
      const request = fetch(input, init);
      first = request.then(
        () => undefined,
        (error: unknown) => {
          const cause = sshCause(error);
          if (connectionFailure(error)) fatal = { error };
          // The deadline or a cancel ends everything anyway; only the request's own limit is about ssh.
          else if (!init?.signal?.aborted && cause instanceof Error && cause.name === 'TimeoutError') {
            const seconds = Math.ceil(timeoutMs / 1000);
            fatal = {
              error: new SshConnectionError(
                `ssh ${destination} did not finish connecting, or ${target} there did not answer, within ${seconds} s. Run \`ssh ${destination}\` in a terminal to check that it connects. If it does, ${advice}, then test again.`
              ),
            };
          }
        }
      );
      return request;
    }
    await first;
    if (fatal) throw fatal.error;
    init?.signal?.throwIfAborted();
    return fetch(input, init);
  };
}

/**
 * Gives each request its own limit from when it starts, so time spent waiting behind the login is not counted.
 * `expired` runs only when a limit ends before its request has settled, body included.
 */
function timed(fetch: FetchLike, timeoutMs: number, expired: () => void): FetchLike {
  return async (input, init = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    let settled = false;
    const settle = () => {
      settled = true;
    };
    timeout.addEventListener(
      'abort',
      () => {
        if (!settled) expired();
      },
      { once: true }
    );
    try {
      const response = await fetch(input, {
        ...init,
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
      return settlesWith(response, settle);
    } catch (error) {
      settle();
      throw error;
    }
  };
}

/** The same response, calling `settle` once its body has been read, failed or cancelled. */
function settlesWith(response: Response, settle: () => void): Response {
  const source = response.body;
  if (!source) {
    settle();
    return response;
  }
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          settle();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    cancel(reason) {
      settle();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function isLmStudio(fetch: FetchLike, baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/v0/models`);
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    return lmStudioModelsSchema.safeParse(await response.json()).success;
  } catch {
    return false;
  }
}

/** A 401 with an API-style JSON error, not a login page that happens to sit on a usual port. */
async function apiStyleRefusal(fetch: FetchLike, baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`);
    if (response.status !== 401) {
      await response.body?.cancel();
      return false;
    }
    const body = (await response.json()) as { error?: unknown } | null;
    return typeof body === 'object' && body !== null && body.error !== undefined;
  } catch {
    return false;
  }
}

const requestTimeout = (options: SshDiscoveryOptions) => options.requestTimeoutMs ?? SSH_PROBE_TIMEOUT_MS;
const deadlineOf = (options: SshDiscoveryOptions) => options.deadlineMs ?? SSH_DISCOVERY_DEADLINE_MS;

/** `fetch` is gated and timed; `expired` says whether one of its requests ran out its own limit. */
async function probePort(
  port: number,
  fetch: FetchLike,
  options: SshDiscoveryOptions,
  signal: AbortSignal,
  expired: () => boolean
): Promise<PortResult> {
  const errors: unknown[] = [];
  const tracked: FetchLike = async (input, init = {}) => {
    try {
      if (signal.aborted) throw signal.reason;
      return await fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
    } catch (error) {
      errors.push(error);
      throw error;
    }
  };
  const baseUrl = sshServerUrl(port);
  const label = `127.0.0.1:${port} on ${options.destination}`;
  const outcome = await probeServer(tracked, baseUrl, label, options.now, undefined, null);
  if (outcome.kind) {
    const lmStudio = outcome.kind === 'openai-compatible' && !outcome.product && (await isLmStudio(tracked, baseUrl));
    return {
      state: 'found',
      server: {
        port,
        kind: outcome.kind,
        product: lmStudio ? 'lmstudio' : outcome.product,
        version: outcome.version,
        models: outcome.models,
        latencyMs: outcome.latencyMs,
        needsCredentials: false,
      },
    };
  }
  // A port the user named is taken at its word; a usual port must look like an API that wants a key.
  if (outcome.auth && (options.port !== undefined || (await apiStyleRefusal(tracked, baseUrl)))) {
    return {
      state: 'found',
      server: {
        port,
        kind: 'openai-compatible',
        product: null,
        version: null,
        models: null,
        latencyMs: outcome.latencyMs,
        needsCredentials: true,
      },
    };
  }
  const causes = errors.map(sshCause);
  const fatal = errors.find(connectionFailure);
  if (fatal !== undefined) return { state: 'failed', error: sshCause(fatal) };
  if (signal.aborted) return { state: 'timeout', limitMs: deadlineOf(options) };
  const refused = causes.filter((cause): cause is SshForwardRefusedError => cause instanceof SshForwardRefusedError);
  if (refused.length > 0) return { state: 'closed', ambiguous: refused.some(cause => cause.ambiguous) };
  if (causes.some(cause => errorCode(cause) === 'ECONNREFUSED')) return { state: 'closed', ambiguous: false };
  // A body that stalls past its limit leaves no fetch error, only the expired limit.
  if (expired()) return { state: 'timeout', limitMs: requestTimeout(options) };
  if (errors.length === 0) {
    return { state: 'other', message: outcome.error ?? `${label} answered, but not as a model server.` };
  }
  return { state: 'failed', error: causes[0] };
}

const FORWARDING_HINT =
  ' If a server is running there, check that its sshd_config allows TCP forwarding (AllowTcpForwarding).';

function usualPorts(): string {
  return SSH_DISCOVERY_PORTS.map(({ port, usual }) => `${usual} ${port}`).join(', ');
}

/** What to do when nothing was found, in order of what most likely went wrong. */
function nothingFound(results: PortResult[], ports: number[], options: SshDiscoveryOptions): SshDiscovery {
  const { destination } = options;
  const failed = results.find(result => result.state === 'failed');
  if (failed?.state === 'failed') {
    const message = describeFailure(failed.error);
    const error = failed.error instanceof SshConnectionError || failed.error instanceof SshRefusedError;
    return {
      found: [],
      error: error ? message : `Could not reach ${destination} over SSH: ${message}`,
      refused: failed.error instanceof SshRefusedError,
    };
  }
  const limits = results.flatMap(result => (result.state === 'timeout' ? [result.limitMs] : []));
  if (limits.length > 0) {
    const seconds = Math.ceil(Math.max(...limits) / 1000);
    return {
      found: [],
      error: `${destination} did not answer within ${seconds} s. Check that \`ssh ${destination}\` connects from a terminal, then test again.`,
      refused: false,
    };
  }
  const others = results.flatMap((result, index) => (result.state === 'other' ? [ports[index]] : []));
  const ambiguous = results.some(result => result.state === 'closed' && result.ambiguous);
  if (options.port !== undefined) {
    const error =
      others.length > 0
        ? `Something answers at 127.0.0.1:${options.port} on ${destination}, but not as Ollama or an OpenAI-compatible server. Check the port.`
        : `SSH to ${destination} works, but nothing answers at 127.0.0.1:${options.port} there. Start the model server on that machine, or check its port.${ambiguous ? FORWARDING_HINT : ''}`;
    return { found: [], error, refused: false };
  }
  const answered =
    others.length > 0
      ? ` Port ${others.join(' and ')} answered, but not as Ollama or an OpenAI-compatible server.`
      : '';
  return {
    found: [],
    error: `SSH to ${destination} works, but no model server answers on the usual ports there (${usualPorts()}). Start the server on that machine, or enter the port it listens on.${answered}${ambiguous ? FORWARDING_HINT : ''}`,
    refused: false,
  };
}

/**
 * Finds the model servers on the far end's loopback: on `options.port` alone, or on every usual port at once after
 * the first request has logged in. Bounded by `deadlineMs` in all, and no request starts once it or `signal` has
 * ended. Sends no credential: a server that wants one is reported with `needsCredentials`.
 */
export async function discoverSshServers(options: SshDiscoveryOptions): Promise<SshDiscovery> {
  const ports = options.port === undefined ? SSH_DISCOVERY_PORTS.map(({ port }) => port) : [options.port];
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException('SSH discovery took too long', 'TimeoutError')),
    deadlineOf(options)
  );
  timer.unref?.();
  const signal = options.signal ? AbortSignal.any([deadline.signal, options.signal]) : deadline.signal;
  const gate = firstRequestAlone(options.destination, requestTimeout(options), options.port !== undefined);
  try {
    options.signal?.throwIfAborted();
    const results = await Promise.all(
      ports.map(port => {
        let expired = false;
        const fetch = gate(
          timed(options.fetchFor(port), requestTimeout(options), () => {
            expired = true;
          })
        );
        return probePort(port, fetch, options, signal, () => expired);
      })
    );
    options.signal?.throwIfAborted();
    const found = results.flatMap(result => (result.state === 'found' ? [result.server] : []));
    if (found.length > 0) return { found, error: null, refused: false };
    return nothingFound(results, ports, options);
  } finally {
    clearTimeout(timer);
  }
}
