import { User, publishedArtifactViewAuditRepository } from '@bike4mind/database';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import type { PublishedArtifactViewGateKind } from '@bike4mind/database';

export interface RecordGatedViewInput {
  publicId: string;
  viewerId: string;
  gateKind: PublishedArtifactViewGateKind;
  sourceIp?: string;
  userAgent?: string;
}

/**
 * Audit an authenticated view of a gated published artifact - "which account
 * viewed which shared item" (issue #408). Best-effort and fire-and-forget: it
 * resolves the viewer's verified email domain for the record but NEVER blocks or
 * fails the serve path. Only the caller decides when to call it (today: a
 * domain-gated view whose access check passed with a logged-in viewer).
 */
export async function recordGatedView(input: RecordGatedViewInput): Promise<void> {
  try {
    const viewer = await User.findById(input.viewerId).select('email').lean<{ email?: string } | null>();
    const email = viewer?.email?.toLowerCase() ?? '';
    const emailDomain = email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : '';
    await publishedArtifactViewAuditRepository.createLog({
      publicId: input.publicId,
      viewerId: input.viewerId,
      gateKind: input.gateKind,
      viewerEmailDomain: registrableDomain(emailDomain) ?? undefined,
      sourceIp: input.sourceIp,
      userAgent: input.userAgent,
    });
  } catch {
    // Best-effort audit; a failed write must never affect serving.
  }
}
