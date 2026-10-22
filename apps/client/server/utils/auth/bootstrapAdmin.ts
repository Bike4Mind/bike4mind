import { randomUUID } from 'crypto';
import { adminSettingsRepository } from '@bike4mind/database';

export const BOOTSTRAP_ADMIN_EMAIL_ENV = 'B4M_BOOTSTRAP_ADMIN_EMAIL';
const BOOTSTRAP_CLAIM_SETTING = 'selfHostBootstrap';
// A claim this old belongs to a registration that died without releasing it; a live one finishes in seconds.
const BOOTSTRAP_CLAIM_STALE_MS = 5 * 60 * 1000;

export function configuredBootstrapAdminEmail(): string | undefined {
  return process.env[BOOTSTRAP_ADMIN_EMAIL_ENV]?.trim().toLowerCase() || undefined;
}

export interface BootstrapAdminDecision {
  eligible: boolean;
  // Eligible only through the first-account fallback because no bootstrap email is configured.
  unconfigured: boolean;
}

/** Whether this verified email may become the self-host install's first admin. */
export function resolveBootstrapAdmin(input: {
  isSelfHost: boolean;
  userCount: number;
  email: string;
  bootstrapEmail: string | undefined;
}): BootstrapAdminDecision {
  if (!input.isSelfHost || input.userCount > 0) return { eligible: false, unconfigured: false };
  const bootstrapEmail = input.bootstrapEmail?.trim().toLowerCase();
  if (bootstrapEmail) return { eligible: input.email === bootstrapEmail, unconfigured: false };
  return { eligible: true, unconfigured: true };
}

/** One-time claim on the bootstrap admin slot. Returns the claim id when this caller won it. */
export async function claimBootstrapAdmin(): Promise<string | null> {
  const claimId = randomUUID();
  return (await adminSettingsRepository.claimOnce(BOOTSTRAP_CLAIM_SETTING, claimId, BOOTSTRAP_CLAIM_STALE_MS))
    ? claimId
    : null;
}

// For a registration that failed after winning the claim, so the next attempt can still take it.
export async function releaseBootstrapAdminClaim(claimId: string): Promise<void> {
  await adminSettingsRepository.releaseClaim(BOOTSTRAP_CLAIM_SETTING, claimId);
}
