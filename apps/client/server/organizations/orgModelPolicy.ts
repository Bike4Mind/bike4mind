import {
  INVALID_ORG_MODEL_POLICY,
  OrgModelPolicySchema,
  readOrgModelPolicy,
  type OrgModelPolicy,
  type StoredOrgModelPolicy,
} from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/utils';

export type OrgModelPolicyField = keyof OrgModelPolicy;
export const ORG_MODEL_POLICY_FIELDS: readonly OrgModelPolicyField[] = [
  'allowedProviders',
  'allowedModels',
  'allowedTools',
];

export type OrgModelPolicyView = {
  /** The effective policy; every list null when the org has none. */
  policy: StoredOrgModelPolicy;
  /** The stored row no longer parses; enforcement treats it as deny-all until it is saved or reset. */
  invalidStored: boolean;
};

const UNRESTRICTED: OrgModelPolicy = OrgModelPolicySchema.parse({});

export function toOrgModelPolicyView(raw: unknown): OrgModelPolicyView {
  const read = readOrgModelPolicy(raw);
  if (read === INVALID_ORG_MODEL_POLICY) return { policy: UNRESTRICTED, invalidStored: true };
  return { policy: read ?? UNRESTRICTED, invalidStored: false };
}

export async function getOrgModelPolicy(orgId: string): Promise<OrgModelPolicyView> {
  const org = await organizationRepository.findById(orgId);
  if (!org) throw new NotFoundError('Organization not found');
  return toOrgModelPolicyView(org.modelPolicy);
}

/** Store the policy; an all-null policy removes the field so the org reads as unrestricted. */
export async function setOrgModelPolicy(orgId: string, policy: OrgModelPolicy): Promise<void> {
  const stored: Partial<OrgModelPolicy> = {};
  for (const field of ORG_MODEL_POLICY_FIELDS) {
    if (policy[field] !== null) Object.assign(stored, { [field]: policy[field] });
  }
  if (Object.keys(stored).length === 0) return resetOrgModelPolicy(orgId);
  await organizationRepository.update({ id: orgId, modelPolicy: stored });
}

export async function resetOrgModelPolicy(orgId: string): Promise<void> {
  await organizationRepository.update({ id: orgId }, { unset: ['modelPolicy'] });
}

/**
 * The fields whose value differs, for the admin audit `changes` list. Over an invalid stored row (whose
 * old value was not in force as written) every field the new policy sets counts; null-to-null never does.
 */
export function diffOrgModelPolicy(
  before: OrgModelPolicyView,
  after: OrgModelPolicy
): Array<{ field: OrgModelPolicyField; before: string[] | null; after: string[] | null }> {
  const changes: Array<{ field: OrgModelPolicyField; before: string[] | null; after: string[] | null }> = [];
  for (const field of ORG_MODEL_POLICY_FIELDS) {
    const prev = before.invalidStored ? null : before.policy[field];
    const next = after[field];
    if (before.invalidStored ? next === null : sameList(prev, next)) continue;
    changes.push({ field, before: prev, after: next });
  }
  return changes;
}

function sameList(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  const sortedB = [...b].sort();
  return [...a].sort().every((item, i) => item === sortedB[i]);
}
