import { Chip, Tooltip } from '@mui/joy';
import type { DataLakeMembershipArm } from '@bike4mind/common';

const LABEL: Record<DataLakeMembershipArm, string> = {
  meta: 'Lake tag',
  prefix: 'Content prefix only',
  both: 'Lake tag + content prefix',
};

const TOOLTIP: Record<DataLakeMembershipArm, string> = {
  meta: "Member because this file carries the lake's own membership tag.",
  prefix:
    "Member SOLELY because this file (owned by the lake's creator) carries a tag under the lake's content prefix - no lake tag was ever applied - this file has none of the lake's membership tag, so it will not act like an ordinary member everywhere the meta-tag is assumed.",
  both: 'Member via both the lake tag and a content-prefix tag.',
};

/**
 * Per-file badge naming which membership signal made a file a lake member.
 * `meta` and `prefix` behave differently (the prefix arm requires the
 * lake's creator to own the file; the meta-tag does not), so silently rendering members
 * identically hid that a third of a lake could be invisible to a share, or vanish on an
 * ownership change, with no way for the owner to tell which files were at risk.
 */
export default function MembershipArmBadge({ arm }: { arm: DataLakeMembershipArm | undefined }) {
  if (!arm) return null;
  return (
    <Tooltip title={TOOLTIP[arm]} size="sm">
      <Chip
        size="sm"
        variant={arm === 'prefix' ? 'soft' : 'outlined'}
        color={arm === 'prefix' ? 'warning' : 'neutral'}
        sx={{ fontSize: '11px' }}
        data-testid="datalake-membership-arm-badge"
      >
        {LABEL[arm]}
      </Chip>
    </Tooltip>
  );
}
