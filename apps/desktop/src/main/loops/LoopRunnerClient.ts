import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { isAxiosError } from 'axios';
import type { LoopMergePolicy, LoopStageGuards } from '@shared/loopRunner';
import type { LoopProgressFrame } from './progress';

/**
 * The server side of the loop runner: the only file that knows its paths and shapes. Every
 * route is first-party (the device-flow token), behind the server's EnableLoops setting.
 */

/** A ticket in a desktop-run stage that this user may claim. */
export interface RunnerTicket {
  ticketId: string;
  title: string;
  loopId: string;
  loopName: string;
  stage: string;
  /** `owner/name` of the repository the loop works in, when the server knows it. */
  repoHint?: string;
}

/** What the server says about the stage, already resolved (an org without green-ci gets 'review'). */
export interface RunnerStageConfig {
  mergePolicy: LoopMergePolicy;
  guards?: LoopStageGuards;
}

export interface RunnerClaim {
  ticket: RunnerTicket;
  /** The run record the web run view shows; tagged on this run's completions. */
  runId: string;
  leaseExpiresAt: string;
  /** Built by the server from the stage instructions, the ticket and the loop's memory. */
  prompt: string;
  stage: RunnerStageConfig;
}

export type RunnerOutcome =
  | { outcome: 'advanced'; answer: string }
  | { outcome: 'blocked'; reason: string; answer?: string }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'released'; reason?: string };

export interface RunnerPresence {
  lanesBusy: number;
  lanesFree: number;
  waitingReason?: string;
}

/** The run's lease is gone (expired, or the ticket was taken back): stop working on it. */
export class LeaseLost extends Error {
  constructor(runId: string) {
    super(`The lease on run ${runId} was lost.`);
    this.name = 'LeaseLost';
  }
}

export interface LoopRunnerApi {
  listTickets(): Promise<RunnerTicket[]>;
  /** Null when the ticket is no longer claimable (taken by another runner, or moved on). */
  claim(ticketId: string): Promise<RunnerClaim | null>;
  heartbeat(runId: string): Promise<void>;
  progress(runId: string, frames: LoopProgressFrame[]): Promise<void>;
  /** `durationMs` is recorded for every run; credits are attributed server-side by run id. */
  complete(runId: string, outcome: RunnerOutcome & { durationMs: number }): Promise<void>;
  presence(presence: RunnerPresence): Promise<void>;
}

const BASE = '/api/loops/runner';

function conflict(err: unknown): boolean {
  return isAxiosError(err) && (err.response?.status === 409 || err.response?.status === 410);
}

/** The HTTP client over the signed-in session; throws when signed out. */
export class HttpLoopRunnerClient implements LoopRunnerApi {
  constructor(private readonly api: () => AuthenticatedApiClient | null) {}

  private client(): AuthenticatedApiClient {
    const api = this.api();
    if (!api) throw new Error('Sign in to run loop tickets.');
    return api;
  }

  async listTickets(): Promise<RunnerTicket[]> {
    const body = await this.client().get<{ tickets?: RunnerTicket[] }>(`${BASE}/tickets`);
    return body.tickets ?? [];
  }

  async claim(ticketId: string): Promise<RunnerClaim | null> {
    try {
      return await this.client().post<RunnerClaim>(`${BASE}/claim`, { ticketId });
    } catch (err) {
      if (conflict(err)) return null;
      throw err;
    }
  }

  private async onRun(runId: string, action: string, body: unknown): Promise<void> {
    try {
      await this.client().post(`${BASE}/runs/${encodeURIComponent(runId)}/${action}`, body);
    } catch (err) {
      if (conflict(err)) throw new LeaseLost(runId);
      throw err;
    }
  }

  heartbeat(runId: string): Promise<void> {
    return this.onRun(runId, 'heartbeat', {});
  }

  progress(runId: string, frames: LoopProgressFrame[]): Promise<void> {
    return this.onRun(runId, 'progress', { frames });
  }

  complete(runId: string, outcome: RunnerOutcome & { durationMs: number }): Promise<void> {
    return this.onRun(runId, 'complete', outcome);
  }

  async presence(presence: RunnerPresence): Promise<void> {
    await this.client().post(`${BASE}/presence`, presence);
  }
}
