import type { ComponentType } from 'react';
import type { DataLakeOrigin } from '@bike4mind/common';
import CloudIcon from '@mui/icons-material/Cloud';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import GitHubIcon from '@mui/icons-material/GitHub';
import { useUser } from '@client/app/contexts/UserContext';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { useGetUserOrganizations } from '@client/app/hooks/data/organizations';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { hasOrgUpdateAccess } from '@client/app/utils/orgAccessGate';
import type { LakeSourceAvailability } from '@client/app/components/datalake/lakeSources';
import type { CreateLakeSourceKind } from '@client/app/components/datalake/createLakeSourceKinds';
import {
  GITHUB_LAKE_ADMIN_FLAG,
  GITHUB_ORG_MANAGER_ONLY_REASON,
  GITHUB_ORG_ONLY_REASON,
  orgIdOfAccount,
} from '@client/app/components/datalake/lakeSourceShared';

export { createLakeOrigin, createSourceRequiresUpload } from '@client/app/components/datalake/createLakeSourceKinds';
export type { CreateLakeSourceKind } from '@client/app/components/datalake/createLakeSourceKinds';

/**
 * Where a lake being CREATED gets its content from - the first question the wizard asks.
 *
 * Sibling of `lakeSources.ts`, which answers the same question for a lake that already exists. The
 * two registries are deliberately separate: that one resolves availability from the LAKE (its org,
 * whether the caller manages it) and renders a connect panel bound to its id, while a create has no
 * lake yet and must resolve from the account scope the lake will be born into. Upload has no entry
 * there at all, since appending files needs no source declaration.
 */
export const GITHUB_CREATE_ORG_ONLY_REASON = GITHUB_ORG_ONLY_REASON;
export const GITHUB_CREATE_ORG_MANAGER_ONLY_REASON = GITHUB_ORG_MANAGER_ONLY_REASON;

/** The account scope a create lands in, which is what decides a source's availability. */
export type CreateLakeScope = {
  /** The organization the lake will belong to, or undefined in a personal workspace. */
  organizationId?: string;
  /**
   * Whether the caller may act for that organization: its billing owner, its manager, or a platform
   * admin. Mirrors the server's `verifyOrgAccess`, which is the gate the connect route gets held to.
   * Meaningless (and false) without an `organizationId`.
   */
  isOrgOwnerOrManager: boolean;
};

export type CreateLakeSource = {
  kind: CreateLakeSourceKind;
  label: string;
  /** One line under the label, on the card itself. */
  hint: string;
  Icon: ComponentType;
  /**
   * What the lake declares about who may fill it. A connector source must be born connector-fed or
   * its own bind door refuses it (see acceptsConnectorContent).
   */
  origin: DataLakeOrigin;
  /** Admin flag the source's routes sit behind; unset means always on. */
  adminFlag?: string;
  /** Why this scope cannot take the source, or undefined when it can. */
  unavailableReason: (scope: CreateLakeScope) => string | undefined;
};

const upload: CreateLakeSource = {
  kind: 'upload',
  label: 'Upload files',
  hint: 'Drop files or a folder from this computer',
  Icon: CloudUploadIcon,
  origin: 'curated',
  unavailableReason: () => undefined,
};

const googleDrive: CreateLakeSource = {
  kind: 'googleDrive',
  label: 'Google Drive',
  hint: 'Sync a Drive folder into the new lake',
  Icon: CloudIcon,
  // Offered in every scope: drive-sync accepts an org lake from an owner/manager and a personal lake
  // from its creator, which the caller always is here. The server stays the authority on the org
  // half, and a refusal rolls the new lake back (see useCreateLakeFromDrive).
  origin: 'connector-fed',
  unavailableReason: () => undefined,
};

const github: CreateLakeSource = {
  kind: 'github',
  label: 'GitHub repository',
  hint: 'Sync a repository into the new lake, read-only',
  Icon: GitHubIcon,
  origin: 'connector-fed',
  adminFlag: GITHUB_LAKE_ADMIN_FLAG,
  unavailableReason: scope => {
    if (!scope.organizationId) return GITHUB_CREATE_ORG_ONLY_REASON;
    return scope.isOrgOwnerOrManager ? undefined : GITHUB_CREATE_ORG_MANAGER_ONLY_REASON;
  },
};

/** Every source a new lake can be fed by, in display order. */
export const CREATE_LAKE_SOURCES: readonly CreateLakeSource[] = [upload, googleDrive, github];

const BY_KIND: Record<CreateLakeSourceKind, CreateLakeSource> = { upload, googleDrive, github };

export const getCreateLakeSource = (kind: CreateLakeSourceKind): CreateLakeSource => BY_KIND[kind];

export function resolveCreateLakeSourceAvailability(
  source: CreateLakeSource,
  scope: CreateLakeScope,
  isAdminFeatureEnabled: (flag: string) => boolean
): LakeSourceAvailability {
  if (source.adminFlag && !isAdminFeatureEnabled(source.adminFlag)) return { status: 'hidden' };
  const reason = source.unavailableReason(scope);
  return reason ? { status: 'disabled', reason } : { status: 'available' };
}

export type OfferedCreateLakeSource = {
  source: CreateLakeSource;
  availability: Exclude<LakeSourceAvailability, { status: 'hidden' }>;
};

/**
 * The account scope the wizard's create will land in. Reads the same account switcher
 * `activeOrgId()` does, so the card gating and the create request cannot disagree about which org
 * the lake belongs to. Manage rights come from the org document the switcher's list already holds -
 * a stale answer only mis-renders a card the server would refuse anyway.
 */
export function useCreateLakeScope(): CreateLakeScope {
  const currentUser = useUser(s => s.currentUser);
  const selectedAccount = useSelectedAccount(s => s.selectedAccount);
  const organizationId = orgIdOfAccount(selectedAccount);
  const { data: organizations } = useGetUserOrganizations(currentUser?.id);
  const org = organizationId ? organizations?.find(o => o.id === organizationId) : undefined;
  return { organizationId, isOrgOwnerOrManager: hasOrgUpdateAccess(currentUser, org) };
}

/** The sources to offer a create, in display order: every flagged-on source, available or disabled. */
export function useOfferedCreateLakeSources(): OfferedCreateLakeSource[] {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const scope = useCreateLakeScope();
  return CREATE_LAKE_SOURCES.flatMap(source => {
    const availability = resolveCreateLakeSourceAvailability(source, scope, isAdminFeatureEnabled);
    return availability.status === 'hidden' ? [] : [{ source, availability }];
  });
}
