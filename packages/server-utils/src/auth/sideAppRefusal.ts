import { sideAppRefusalCounterRepository, sideAppRefusalRepository } from '@bike4mind/database/auth';
import type { SideAppRefusalStage } from '@bike4mind/database/auth';
import { Logger } from '@bike4mind/observability';

export type SideAppRefusalClass = 'policy' | 'app_fault' | 'our_fault';

/**
 * Who a refusal reason points at. Policy refusals are expected, app faults are the app's own
 * mistakes, our faults are ours. Shared by the admin board and the health alerts.
 */
export const SIDE_APP_REFUSAL_CLASS: Readonly<Record<string, SideAppRefusalClass>> = {
  subscription_required: 'policy',
  invalid_scope: 'policy',
  access_denied: 'policy',
  insufficient_scope: 'policy',
  route_not_allowed: 'policy',
  invalid_grant: 'app_fault',
  invalid_request: 'app_fault',
  invalid_client: 'app_fault',
  rate_limited: 'app_fault',
  idp_unavailable: 'app_fault',
  temporarily_unavailable: 'our_fault',
  server_error: 'our_fault',
};

/** A reason missing from the map is surfaced as our fault so it gets looked at, not hidden as policy. */
export function classifySideAppRefusal(reason: string): SideAppRefusalClass {
  return SIDE_APP_REFUSAL_CLASS[reason] ?? 'our_fault';
}

const VERIFIED_CAP_PER_MINUTE = 20;
const VERIFIED_CAP_WINDOW_MS = 60_000;
const VERIFIED_CAP_MAX_ENTRIES = 1000;

// Insertion-ordered, so the first key is the oldest window.
const verifiedWindows = new Map<string, { windowStart: number; count: number }>();

function admitVerified(clientId: string, reason: string, now: number): boolean {
  const key = `${clientId}\u0000${reason}`;
  const windowStart = now - (now % VERIFIED_CAP_WINDOW_MS);
  const entry = verifiedWindows.get(key);
  if (entry && entry.windowStart === windowStart) {
    if (entry.count >= VERIFIED_CAP_PER_MINUTE) return false;
    entry.count += 1;
    return true;
  }
  verifiedWindows.delete(key);
  while (verifiedWindows.size >= VERIFIED_CAP_MAX_ENTRIES) {
    const oldest = verifiedWindows.keys().next().value;
    if (oldest === undefined) break;
    verifiedWindows.delete(oldest);
  }
  verifiedWindows.set(key, { windowStart, count: 1 });
  return true;
}

export const sideAppRefusalCapLimits = {
  perMinute: VERIFIED_CAP_PER_MINUTE,
  maxEntries: VERIFIED_CAP_MAX_ENTRIES,
} as const;

export function sideAppRefusalCapSize(): number {
  return verifiedWindows.size;
}

export function resetSideAppRefusalCap(): void {
  verifiedWindows.clear();
}

export interface SideAppRefusalInput {
  /** True only when the client id is proven: a verified client secret, or an exchange key's own metadata. */
  verified: boolean;
  clientId?: string;
  stage: SideAppRefusalStage;
  reason: string;
  status: number;
  userId?: string;
  keyId?: string;
  endpoint?: string;
}

/**
 * Persist a refused connected-app request. Verified refusals become a row per app (capped per
 * minute); anything else only bumps an hourly counter that never stores the claimed id. Fire and
 * forget: never throws and never blocks the response.
 */
export function recordSideAppRefusal(input: SideAppRefusalInput): void {
  try {
    const { clientId, stage, reason, status, userId, keyId, endpoint } = input;
    let write: Promise<void>;
    if (input.verified && clientId) {
      if (!admitVerified(clientId, reason, Date.now())) return;
      write = sideAppRefusalRepository.record({
        clientId,
        stage,
        reason,
        status,
        ...(userId ? { userId } : {}),
        ...(keyId ? { keyId } : {}),
        ...(endpoint ? { endpoint: endpoint.slice(0, 256) } : {}),
      });
    } else {
      write = sideAppRefusalCounterRepository.increment(reason);
    }
    write.catch(error => warnWriteFailed(error));
  } catch (error) {
    warnWriteFailed(error);
  }
}

function warnWriteFailed(error: unknown): void {
  try {
    Logger.globalInstance.warn(
      `[SIDE_APP_REFUSAL] write failed: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  } catch {
    // Recording is best effort and must never surface to the caller.
  }
}
