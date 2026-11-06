import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { LoopProgressFrame, RunnerClaim, RunnerHeldLoop, RunnerOutcome, RunnerTicket } from '@bike4mind/common';
import { isAxiosError } from 'axios';

/**
 * The server side of the loop runner (apps/client/pages/api/loops/runner, shapes in
 * @bike4mind/common LoopTypes): the only file that knows its paths. Every route is first-party
 * (the device-flow token), behind the server's EnableLoops setting.
 */

export type { RunnerClaim, RunnerHeldLoop, RunnerOutcome, RunnerTicket };

export interface RunnerTicketList {
  tickets: RunnerTicket[];
  /** Loops with ready tickets their budgets hold back now. */
  held: RunnerHeldLoop[];
}

export interface RunnerPresence {
  lanesBusy: number;
  lanesFree: number;
  waitingReason?: string;
  /** The app is quitting: the server shows the runner offline at once rather than after the freshness window. */
  offline?: true;
}

/** A claim the server turned down, with its `reason` (e.g. `claimed`, `lanes_full`, `credits`). */
export interface ClaimRefused {
  refused: string;
}

/** Refusals that hold for every ticket this poll, so the runner stops trying until the next one. */
export const USER_WIDE_REFUSALS: ReadonlySet<string> = new Set(['lanes_full', 'user_budget']);

/**
 * The run has ended on the server (410: completed, `aborted` from the web run view, `credit_cap`,
 * or the lease lapsed), or is not this user's (404). Stop working on it; there is nothing to report.
 */
export class LeaseLost extends Error {
  constructor(
    runId: string,
    readonly reason: string
  ) {
    super(`Run ${runId} ended on the server (${reason}).`);
    this.name = 'LeaseLost';
  }
}

export interface LoopRunnerApi {
  listTickets(): Promise<RunnerTicketList>;
  claim(ticketId: string): Promise<RunnerClaim | ClaimRefused>;
  heartbeat(runId: string): Promise<void>;
  progress(runId: string, frames: LoopProgressFrame[]): Promise<void>;
  /** `durationMs` is recorded for every run; credits are attributed server-side by run id. */
  complete(runId: string, outcome: RunnerOutcome): Promise<void>;
  presence(presence: RunnerPresence): Promise<void>;
}

const BASE = '/api/loops/runner';

/** A refusal's status and `reason`, or null for any other failure. */
function refusal(err: unknown): { status: number; reason: string } | null {
  if (!isAxiosError(err)) return null;
  const status = err.response?.status;
  if (status !== 404 && status !== 409 && status !== 410) return null;
  const body = err.response?.data as { reason?: unknown } | undefined;
  return { status, reason: typeof body?.reason === 'string' ? body.reason : String(status) };
}

/** The HTTP client over the signed-in session; throws when signed out. */
export class HttpLoopRunnerClient implements LoopRunnerApi {
  constructor(private readonly api: () => AuthenticatedApiClient | null) {}

  private client(): AuthenticatedApiClient {
    const api = this.api();
    if (!api) throw new Error('Sign in to run loop tickets.');
    return api;
  }

  async listTickets(): Promise<RunnerTicketList> {
    const body = await this.client().get<Partial<RunnerTicketList>>(`${BASE}/tickets`);
    return { tickets: body.tickets ?? [], held: body.held ?? [] };
  }

  async claim(ticketId: string): Promise<RunnerClaim | ClaimRefused> {
    try {
      return await this.client().post<RunnerClaim>(`${BASE}/claim`, { ticketId });
    } catch (err) {
      const refused = refusal(err);
      if (refused) return { refused: refused.reason };
      throw err;
    }
  }

  private async onRun(runId: string, action: string, body: unknown): Promise<void> {
    try {
      await this.client().post(`${BASE}/runs/${encodeURIComponent(runId)}/${action}`, body);
    } catch (err) {
      const refused = refusal(err);
      if (refused && refused.status !== 409) throw new LeaseLost(runId, refused.reason);
      throw err;
    }
  }

  heartbeat(runId: string): Promise<void> {
    return this.onRun(runId, 'heartbeat', {});
  }

  progress(runId: string, frames: LoopProgressFrame[]): Promise<void> {
    return this.onRun(runId, 'progress', { frames });
  }

  complete(runId: string, outcome: RunnerOutcome): Promise<void> {
    return this.onRun(runId, 'complete', outcome);
  }

  async presence(presence: RunnerPresence): Promise<void> {
    await this.client().post(`${BASE}/presence`, presence);
  }
}
