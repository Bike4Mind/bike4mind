import React from 'react';
import { Chip, Tooltip, type ColorPaletteProp } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
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

type PublishGate = NonNullable<ManagedArtifact['gateKind']>;
type AccessSource = Pick<ManagedArtifact, 'visibility' | 'gateKind'>;

const isGate = (value: unknown): value is PublishGate => value === 'passphrase' || value === 'domain';

/** Collapse visibility + gate into a single access state. The gate decides the state only on a
 *  public page; on a non-public page it guards the private links instead (getPrivateLinkGate).
 *  Total over unexpected values so one odd row cannot crash the list: an unknown non-public
 *  visibility is owner-only on the server (checkVisibility), so it reads as private. */
export function getPublishAccess({ visibility, gateKind }: AccessSource): PublishAccess {
  if (visibility === 'public') return isGate(gateKind) ? gateKind : 'public';
  return visibility === 'organization' || visibility === 'project' ? visibility : 'private';
}

/** The gate a NON-public page still enforces. Not stale data: the server applies accessGate to
 *  private links (/a/<token>) at any visibility (checkShareGrant). */
export function getPrivateLinkGate({ visibility, gateKind }: AccessSource): PublishGate | undefined {
  return visibility !== 'public' && isGate(gateKind) ? gateKind : undefined;
}

interface AccessMeta {
  label: string;
  /** One-line meaning, shown as the tooltip. */
  description: string;
  color: ColorPaletteProp;
  Icon: typeof PublicIcon;
}

/** Icons follow PublishShareModal and AccessGateEditor; the labels are deliberately shorter. The non-public descriptions
 *  name private links because the list cannot tell whether one exists, and when it does it opens
 *  for anyone it is sent to (see the share-token section of PublishShareModal). */
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
  organization: {
    label: 'Team',
    description: 'Members of your team, and anyone you send a private link to',
    color: 'neutral',
    Icon: GroupIcon,
  },
  project: {
    label: 'Project',
    description: 'Members of this project, and anyone you send a private link to',
    color: 'neutral',
    Icon: FolderIcon,
  },
  private: {
    label: 'Private',
    description: 'Only you, and anyone you send a private link to',
    color: 'neutral',
    Icon: LockIcon,
  },
};

const PRIVATE_LINK_GATE_NOTE: Record<PublishGate, string> = {
  passphrase: 'Private links also need the passphrase.',
  domain: 'Private links also need a verified email from an allowed domain.',
};

/** The theme's light-mode warning softColor (#FFA500) is about 1.4:1 on its own soft background,
 *  which left a gated badge's word close to unreadable; this darker shade of the hue reaches AA. */
export const LIGHT_WARNING_TEXT = 'warning.700';

export function isPublishAccess(value: string): value is PublishAccess {
  return Object.hasOwn(PUBLISH_ACCESS_META, value);
}

interface PublishAccessBadgeProps extends AccessSource {
  'data-testid'?: string;
}

/** One chip saying who can open the artifact. Icon and word are always both present, so the state
 *  never depends on color alone; a gate on a non-public page adds its icon after the word. */
export function PublishAccessBadge({ visibility, gateKind, 'data-testid': testId }: PublishAccessBadgeProps) {
  const theme = useTheme();
  const mode = theme.palette.mode;
  const access = getPublishAccess({ visibility, gateKind });
  const linkGate = getPrivateLinkGate({ visibility, gateKind });
  const { label, description, color, Icon } = PUBLISH_ACCESS_META[access];
  const GateIcon = linkGate ? PUBLISH_ACCESS_META[linkGate].Icon : undefined;
  return (
    <Tooltip
      title={linkGate ? `${description}. ${PRIVATE_LINK_GATE_NOTE[linkGate]}` : description}
      size="sm"
      describeChild
    >
      <Chip
        size="sm"
        variant="soft"
        color={color}
        startDecorator={<Icon sx={{ fontSize: 14 }} />}
        endDecorator={GateIcon && <GateIcon sx={{ fontSize: 14 }} />}
        sx={color === 'warning' && mode === 'light' ? { color: LIGHT_WARNING_TEXT } : undefined}
        data-testid={testId}
        data-access={access}
        data-link-gate={linkGate}
      >
        {label}
      </Chip>
    </Tooltip>
  );
}
