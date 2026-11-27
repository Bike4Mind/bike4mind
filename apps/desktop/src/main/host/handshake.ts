import { z } from 'zod';
import type { HostConnectionState, HostInfo } from '@shared/hostConnection';
import {
  HOST_ERROR_CODES,
  HOST_PROTOCOL_VERSION,
  HostConnectError,
  HostRequestError,
  hostMethods,
  negotiateHostProtocol,
  type HostConnectFailure,
  type HostTransport,
} from '@shared/hostProtocol';

/** Who this Desktop is, as it introduces itself in `host/initialize`. */
export type ClientIdentity = { clientId: string; clientName: string; clientVersion: string };

/** What a failed attempt to reach a host leads to: another try after a backoff, or a state that waits for the user. */
export type ConnectOutcome =
  { retry: true; failure: HostConnectFailure } | { retry: false; state: HostConnectionState };

const lost = (detail: string): HostConnectFailure => ({ kind: 'lost', detail, stderrTail: '' });

const protocolMismatchData = z.object({ reason: z.enum(['client-too-old', 'host-too-old']) });

const tooOldDesktop = (detail: string): ConnectOutcome => ({
  retry: false,
  state: { status: 'failed', failure: { kind: 'protocolMismatch', detail, stderrTail: '' } },
});

/** A state that waits for the user to install or update the host program. */
export type HostNeedsUserState = Extract<HostConnectionState, { status: 'needsInstall' | 'needsUpdate' }>;

/**
 * A connector's rejection when the machine needs the user first: the host program is missing, or
 * is another version and updating it is the user's call (see HostProvisioner). Never retried.
 */
export class HostNeedsUserError extends Error {
  constructor(readonly state: HostNeedsUserState) {
    super(`Host is ${state.status}`);
    this.name = 'HostNeedsUserError';
  }
}

/** Maps a connector's failure to what happens next. Transient failures retry; the rest need the user. */
export function outcomeForFailure(failure: HostConnectFailure): ConnectOutcome {
  switch (failure.kind) {
    case 'sshFailed':
    case 'daemonStartTimeout':
    case 'lost':
      return { retry: true, failure };
    case 'notInstalled':
      return { retry: false, state: { status: 'needsInstall' } };
    case 'daemonVersionMismatch':
      return { retry: false, state: { status: 'needsUpdate', required: false } };
    case 'protocolMismatch':
      return { retry: false, state: { status: 'needsUpdate', required: true } };
    case 'nodeMissing':
    case 'nodeTooOld':
    case 'unsupportedPlatform':
      return { retry: false, state: { status: 'failed', failure } };
  }
}

/** Anything a connector or a handshake throws, as an outcome. An unexpected error is a lost link, so it retries. */
export function outcomeForError(error: unknown): ConnectOutcome {
  if (error instanceof HostConnectError) return outcomeForFailure(error.failure);
  if (error instanceof HostNeedsUserError) return { retry: false, state: error.state };
  if (error instanceof HostRequestError && error.code === HOST_ERROR_CODES.protocolMismatch) {
    const data = protocolMismatchData.safeParse(error.data);
    if (data.success && data.data.reason === 'client-too-old') {
      return tooOldDesktop(`${error.message}. Update Bike4Mind Desktop to connect.`);
    }
    return { retry: false, state: { status: 'needsUpdate', required: true } };
  }
  return { retry: true, failure: lost(error instanceof Error ? error.message : String(error)) };
}

/** Rejects with a lost-link HostConnectError when `promise` takes longer than `timeoutMs`. */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HostConnectError(lost(`${what} timed out after ${timeoutMs} ms`))), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type Handshake = { ok: true; info: HostInfo } | { ok: false; outcome: ConnectOutcome };

/**
 * Runs `host/initialize` on a fresh connection and checks the answer. A host that refuses this
 * client's major, or answers with another one, ends in an outcome that names which side must update.
 */
export async function initializeHost(
  transport: HostTransport,
  client: ClientIdentity,
  timeoutMs: number
): Promise<Handshake> {
  let raw: unknown;
  try {
    raw = await withTimeout(
      transport.request('host/initialize', { ...client, protocol: HOST_PROTOCOL_VERSION }),
      timeoutMs,
      'host/initialize'
    );
  } catch (error) {
    return { ok: false, outcome: outcomeForError(error) };
  }
  const parsed = hostMethods['host/initialize'].result.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      outcome: tooOldDesktop('The host answered host/initialize in a shape this Desktop does not know'),
    };
  }
  const negotiated = negotiateHostProtocol(HOST_PROTOCOL_VERSION, parsed.data.protocol);
  if (!negotiated.ok) {
    return {
      ok: false,
      outcome:
        negotiated.reason === 'client-too-old'
          ? tooOldDesktop(
              `This host speaks protocol ${parsed.data.protocol.major}.x. Update Bike4Mind Desktop to connect.`
            )
          : { retry: false, state: { status: 'needsUpdate', required: true } },
    };
  }
  return { ok: true, info: parsed.data };
}

/** `host/info` timed for latency; rejects as a lost link when it fails, times out or answers out of shape. */
export async function measureHost(
  transport: HostTransport,
  timeoutMs: number,
  now: () => number
): Promise<{ info: HostInfo; latencyMs: number }> {
  const started = now();
  const raw = await withTimeout(transport.request('host/info'), timeoutMs, 'host/info');
  const latencyMs = Math.max(0, now() - started);
  const parsed = hostMethods['host/info'].result.safeParse(raw);
  if (!parsed.success) throw new HostConnectError(lost('The host answered host/info in an unknown shape'));
  return { info: parsed.data, latencyMs };
}
