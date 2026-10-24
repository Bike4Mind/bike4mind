import React from 'react';
import { Chip, Tooltip, type ColorPaletteProp } from '@mui/joy';
import PublicIcon from '@mui/icons-material/Public';
import KeyIcon from '@mui/icons-material/Key';
import DomainIcon from '@mui/icons-material/Domain';
import GroupIcon from '@mui/icons-material/Group';
import FolderIcon from '@mui/icons-material/Folder';
import LockIcon from '@mui/icons-material/Lock';
import type { ManagedArtifact } from '@client/app/utils/publishApi';

/**
 * Who can open a published artifact, as one value. Visibility alone cannot say it: a public page
 * may also sit behind a passphrase or an email-domain gate, and those are the cases a reader most
 * needs told apart from plain "anyone with the link".
 */
export type PublishAccess = 'public' | 'passphrase' | 'domain' | 'organization' | 'project' | 'private';

type AccessSource = Pick<ManagedArtifact, 'visibility' | 'gateKind'>;

/** Collapse visibility + gate into a single access state. Gates only apply on public pages, so a
 *  gateKind on a non-public row (stale data) is ignored and visibility wins. */
export function getPublishAccess({ visibility, gateKind }: AccessSource): PublishAccess {
  if (visibility !== 'public') return visibility;
  return gateKind ?? 'public';
}

interface AccessMeta {
  label: string;
  /** One-line meaning, shown as the tooltip. */
  description: string;
  color: ColorPaletteProp;
  Icon: typeof PublicIcon;
}

/** Wording follows PublishShareModal and AccessGateEditor so the badge, the publish dialog and
 *  the gate editor describe each state the same way. */
export const PUBLISH_ACCESS_META: Record<PublishAccess, AccessMeta> = {
  public: { label: 'Public', description: 'Anyone with the link', color: 'success', Icon: PublicIcon },
  passphrase: {
    label: 'Passphrase',
    description: 'Anyone with the link and the passphrase',
    color: 'warning',
    Icon: KeyIcon,
  },
  domain: {
    label: 'Domain',
    description: 'Anyone who signs in with a verified email from an allowed domain',
    color: 'warning',
    Icon: DomainIcon,
  },
  organization: { label: 'Team', description: 'Members of your team', color: 'neutral', Icon: GroupIcon },
  project: { label: 'Project', description: 'Members of this project', color: 'neutral', Icon: FolderIcon },
  private: { label: 'Private', description: 'Only you', color: 'neutral', Icon: LockIcon },
};

export function isPublishAccess(value: string): value is PublishAccess {
  return Object.hasOwn(PUBLISH_ACCESS_META, value);
}

interface PublishAccessBadgeProps extends AccessSource {
  'data-testid'?: string;
}

/** One chip saying who can open the artifact. Icon and word are always both present, so the state
 *  never depends on color alone. */
export function PublishAccessBadge({ visibility, gateKind, 'data-testid': testId }: PublishAccessBadgeProps) {
  const access = getPublishAccess({ visibility, gateKind });
  const { label, description, color, Icon } = PUBLISH_ACCESS_META[access];
  return (
    <Tooltip title={description} size="sm" describeChild>
      <Chip
        size="sm"
        variant="soft"
        color={color}
        startDecorator={<Icon sx={{ fontSize: 14 }} />}
        data-testid={testId}
        data-access={access}
      >
        {label}
      </Chip>
    </Tooltip>
  );
}
