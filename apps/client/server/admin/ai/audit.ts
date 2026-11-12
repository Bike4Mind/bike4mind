import {
  ADMIN_AI_FEATURES,
  type AdminAiFeature,
  type AdminAiSuggestionItem,
  type AdminAiSuggestionStatus,
  type AuditActor,
} from '@bike4mind/common';
import { adminAiSuggestionRepository, type AdminAiSuggestionDecision } from '@bike4mind/database';
import { systemAuditActor } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/utils';
import { getAdminAiClassReadiness } from './readiness';

/**
 * Audit glue for admin AI suggestions. An admin accepting a suggestion goes through the existing
 * audited handler for that action (the actor stays the admin); only `act` mode, where nothing is
 * clicked, records the per-feature system actor below.
 */

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** The named system actor that `act` mode records for a feature, e.g. `admin-ai:abuseAssessment`. */
export const adminAiSystemActor = (feature: AdminAiFeature): AuditActor => systemAuditActor(`admin-ai:${feature}`);

export const ADMIN_AI_SYSTEM_ACTORS: Readonly<Record<AdminAiFeature, AuditActor>> = Object.fromEntries(
  ADMIN_AI_FEATURES.map(feature => [feature, adminAiSystemActor(feature)])
) as Record<AdminAiFeature, AuditActor>;

/** Adds the suggestion id to a manual action's audit details, keeping every existing key. */
export const withAiSuggestionId = <T extends Record<string, unknown>>(
  details: T,
  aiSuggestionId: string
): T & { aiSuggestionId: string } => ({ ...details, aiSuggestionId });

/**
 * Reads `aiSuggestionId` from a request body: undefined when the key is absent, else it must be a
 * 24-hex ObjectId. An empty string is invalid, not absent, so a broken client cannot drop the link.
 */
export function readAiSuggestionId(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || !('aiSuggestionId' in body)) return undefined;
  const value = (body as { aiSuggestionId: unknown }).aiSuggestionId;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !OBJECT_ID_RE.test(value)) {
    throw new BadRequestError('aiSuggestionId must be a 24-character hex id');
  }
  return value.toLowerCase();
}

/**
 * Closes a pending suggestion with the admin's (or system's) decision. Null when it was already
 * decided or does not exist, so a second accept never applies twice.
 */
export const recordAiDecision = async (
  id: string,
  to: Exclude<AdminAiSuggestionStatus, 'pending'>,
  decision: AdminAiSuggestionDecision = {}
): Promise<AdminAiSuggestionItem | null> => {
  const item = await adminAiSuggestionRepository.transition(id, ['pending'], to, decision);
  if (item?.actionClass)
    await getAdminAiClassReadiness({
      feature: item.feature,
      actionClass: item.actionClass,
      policyVersion: item.policyVersion,
    });
  return item;
};
