import { sideAppRefusalCounterRepository, sideAppRefusalRepository } from '@bike4mind/database/auth';
import type { SideAppRefusalStage } from '@bike4mind/database/auth';
import { Logger } from '@bike4mind/observability';

export { SIDE_APP_MINT_OUR_FAULT_EVENT } from './sideAppMintEvent';

export { SIDE_APP_REFUSAL_CLASS, classifySideAppRefusal, type SideAppRefusalClass } from './sideAppRefusalClass';

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
