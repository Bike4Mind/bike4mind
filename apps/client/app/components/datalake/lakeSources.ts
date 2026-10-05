import type { ComponentType } from 'react';
import CloudIcon from '@mui/icons-material/Cloud';
import GitHubIcon from '@mui/icons-material/GitHub';
import DriveConnectAction from '@client/app/components/DataLakeWizard/steps/DriveConnectAction';
import { DRIVE_PERSONAL_OWNER_ONLY_REASON } from '@client/app/components/DataLakeWizard/steps/DriveConnectUnavailableButton';
import GitHubConnectAction from '@client/app/components/DataLakeWizard/steps/GitHubConnectAction';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';
import { canConnectLakeDrive } from '@client/app/components/datalake/lakeVisibility';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';

/** Must stay in sync with the server's LakeConnectorKind (server/dataLakes/assertLakeConnectorFree.ts). */
export type LakeSourceKind = 'googleDrive' | 'github';

export const GITHUB_ORG_ONLY_REASON = `GitHub repositories can only feed an organization ${DATA_LAKE}.`;
export const LAKE_MANAGER_ONLY_REASON = `Only people who can manage this ${DATA_LAKE} can connect a source to it.`;

/** The lake fields availability is decided from. Absent fields fail closed, as in canConnectLakeDrive. */
export type LakeSourceLake = {
  organizationId?: string | null;
  canManage?: boolean;
  isCreator?: boolean;
};

export type LakeSourceAvailability =
  | { status: 'available' }
  | { status: 'disabled'; reason: string }
  /** The source's feature flag is off: its routes 403, so it is not offered at all. */
  | { status: 'hidden' };

export type LakeSource = {
  kind: LakeSourceKind;
  label: string;
  /** One line on what connecting does, shown while the source is available. */
  hint: string;
  Icon: ComponentType;
  /** Admin flag the source's routes sit behind; unset means always on. */
  adminFlag?: string;
  /** Why this lake cannot take the source, or undefined when it can. Mirrors the server's connect gate. */
  unavailableReason: (lake: LakeSourceLake) => string | undefined;
  /** Connect/status control for an existing lake. */
  Panel: ComponentType<{ lake: { id: string } }>;
};

const googleDrive: LakeSource = {
  kind: 'googleDrive',
  label: 'Google Drive',
  hint: 'Sync a Drive folder into this lake',
  Icon: CloudIcon,
  unavailableReason: lake => {
    if (canConnectLakeDrive(lake)) return undefined;
    return lake.organizationId ? LAKE_MANAGER_ONLY_REASON : DRIVE_PERSONAL_OWNER_ONLY_REASON;
  },
  Panel: DriveConnectAction,
};

const github: LakeSource = {
  kind: 'github',
  label: 'GitHub',
  hint: 'Sync a repository into this lake',
  Icon: GitHubIcon,
  adminFlag: 'EnableDataLakeGitHub',
  unavailableReason: lake => {
    if (!lake.organizationId) return GITHUB_ORG_ONLY_REASON;
    return lake.canManage ? undefined : LAKE_MANAGER_ONLY_REASON;
  },
  Panel: GitHubConnectAction,
};

/** Every source a lake can be fed by, in display order. */
export const LAKE_SOURCES: readonly LakeSource[] = [googleDrive, github];

const LAKE_SOURCE_BY_KIND: Record<LakeSourceKind, LakeSource> = { googleDrive, github };

export const getLakeSource = (kind: LakeSourceKind): LakeSource => LAKE_SOURCE_BY_KIND[kind];

export function resolveLakeSourceAvailability(
  source: LakeSource,
  lake: LakeSourceLake,
  isAdminFeatureEnabled: (flag: string) => boolean
): LakeSourceAvailability {
  if (source.adminFlag && !isAdminFeatureEnabled(source.adminFlag)) return { status: 'hidden' };
  const reason = source.unavailableReason(lake);
  return reason ? { status: 'disabled', reason } : { status: 'available' };
}

export type OfferedLakeSource = {
  source: LakeSource;
  availability: Exclude<LakeSourceAvailability, { status: 'hidden' }>;
};

/** The sources to list for a lake, in display order: every flagged-on source, available or disabled. */
export function useOfferedLakeSources(lake: LakeSourceLake): OfferedLakeSource[] {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  return LAKE_SOURCES.flatMap(source => {
    const availability = resolveLakeSourceAvailability(source, lake, isAdminFeatureEnabled);
    return availability.status === 'hidden' ? [] : [{ source, availability }];
  });
}
