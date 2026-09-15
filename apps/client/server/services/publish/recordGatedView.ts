import { User, publishedArtifactViewAuditRepository } from '@bike4mind/database';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import type { PublishedArtifactViewGateKind } from '@bike4mind/database';

export interface RecordGatedViewInput {
  publicId: string;
  viewerId: string;
  gateKind: PublishedArtifactViewGateKind;
  /** The viewer's registrable email domain, when the gate check already resolved it
   *  (domain gate). Passed through to avoid a second User lookup; falls back to a
   *  lookup when absent (e.g. an owner/admin who bypassed the gate short-circuit). */
  viewerEmailDomain?: string;
  sourceIp?: string;
  userAgent?: string;
}

/**
 * Audit an authenticated view of a gated published artifact - "which account
 * viewed which shared item" (issue #408). Best-effort and fire-and-forget: NEVER
 * blocks or fails the serve path. Only the caller decides when to call it (today:
 * a non-owner domain-gated view whose access check passed with a logged-in viewer).
 */
export async function recordGatedView(input: RecordGatedViewInput): Promise<void> {
  try {
    let viewerEmailDomain = input.viewerEmailDomain;
    if (!viewerEmailDomain) {
      const viewer = await User.findById(input.viewerId).select('email').lean<{ email?: string } | null>();
      const email = viewer?.email?.toLowerCase() ?? '';
      const emailDomain = email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : '';
      viewerEmailDomain = registrableDomain(emailDomain) ?? undefined;
    }
    await publishedArtifactViewAuditRepository.createLog({
      publicId: input.publicId,
      viewerId: input.viewerId,
      gateKind: input.gateKind,
      viewerEmailDomain,
      // getClientIp returns the literal 'unknown' when it can't resolve a real IP;
      // store nothing rather than pollute the audit with that sentinel.
      sourceIp: input.sourceIp && input.sourceIp !== 'unknown' ? input.sourceIp : undefined,
      userAgent: input.userAgent,
    });
  } catch {
    // Best-effort audit; a failed write must never affect serving.
  }
}
