import { useState } from 'react';
import { Box, Chip, Dropdown, IconButton, Menu, MenuButton, MenuItem, Stack, Tooltip, Typography } from '@mui/joy';
import AllInclusiveIcon from '@mui/icons-material/AllInclusive';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { RegInviteStatusType } from '@bike4mind/common';
import type { ReactNode } from 'react';
import UsernameText from '../../../common/UsernameText';
import { getTagColor } from '../../InviteCenter/shared/tagColors';
import { DataTable, type DataColumn } from '../../shared/DataTable';
import { StatusChip } from '../../shared/StatusChip';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { InviteTableProps, RegInviteData } from '../types';

const STATUS_TONES: Record<string, AdminStatusTone> = {
  open: 'good',
  waiting: 'warn',
  used: 'neutral',
  expired: 'bad',
};

export const InviteTable: React.FC<InviteTableProps & { empty?: ReactNode; label?: string }> = ({
  allInvites,
  selected,
  setSelected,
  sortDirection,
  toggleSortDirection,
  handleUpdate,
  handleDelete,
  copyToClipboard,
  operating,
  copied,
  formatDate,
  empty,
  label = 'Registration invites',
}) => {
  const [now] = useState(() => Date.now());
  const [expandedInviteId, setExpandedInviteId] = useState<string | null>(null);

  const statusLabel = (invite: RegInviteData) =>
    invite.unlimitedUse && invite.expiresAt && new Date(invite.expiresAt).getTime() < now ? 'expired' : invite.status;

  const columns: DataColumn<RegInviteData>[] = [
    {
      id: 'code',
      label: 'Code',
      render: invite => (
        <Stack spacing={0.5}>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <Typography
              data-testid="invite-code-value"
              level="body-sm"
              sx={{ fontFamily: 'monospace', color: 'admin.ink' }}
            >
              {invite.code}
            </Typography>
            <Tooltip title={copied ? 'Copied!' : 'Copy code'}>
              <IconButton
                size="sm"
                variant="plain"
                aria-label={`Copy code ${invite.code}`}
                data-testid="invite-code-copy-btn"
                onClick={() => copyToClipboard(invite.code)}
              >
                <ContentCopyIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </Stack>
          {((invite.tags && invite.tags.length > 0) || invite.startingCredits || invite.startingStorage) && (
            <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
              {invite.tags?.map(tag => (
                <Chip
                  key={tag}
                  size="sm"
                  variant="soft"
                  sx={{ bgcolor: getTagColor(tag) + '22', color: getTagColor(tag), fontSize: '0.65rem' }}
                >
                  {tag}
                </Chip>
              ))}
              {invite.startingCredits != null && invite.startingCredits > 0 && (
                <Chip size="sm" variant="soft" color="success" sx={{ fontSize: '0.65rem' }}>
                  {invite.startingCredits} credits
                </Chip>
              )}
              {invite.startingStorage != null && invite.startingStorage > 0 && (
                <Chip size="sm" variant="soft" color="primary" sx={{ fontSize: '0.65rem' }}>
                  {invite.startingStorage} MB
                </Chip>
              )}
            </Stack>
          )}
        </Stack>
      ),
    },
    {
      id: 'createdBy',
      label: 'Created by',
      render: invite => (invite.userId ? <UsernameText id={invite.userId} /> : 'Unknown'),
    },
    {
      id: 'createdAt',
      label: 'Created',
      sortable: true,
      render: invite => formatDate(invite.createdAt),
    },
    {
      id: 'status',
      label: 'Status',
      render: invite => {
        const status = statusLabel(invite);
        return (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <StatusChip tone={STATUS_TONES[status] ?? 'neutral'} label={status} />
            {invite.unlimitedUse && invite.expiresAt && (
              <Tooltip title={`Expiry date: ${formatDate(invite.expiresAt)}`} size="sm">
                <AllInclusiveIcon aria-label="Unlimited use" sx={{ fontSize: 16, color: 'admin.inkMuted' }} />
              </Tooltip>
            )}
          </Stack>
        );
      },
    },
    {
      id: 'usedBy',
      label: 'Used by',
      render: invite => {
        const history = invite.usageHistory ?? [];
        if (!invite.unlimitedUse) return invite.usedbyId ? <UsernameText id={invite.usedbyId} /> : null;
        const expanded = expandedInviteId === invite.id && history.length > 0;
        return (
          <Stack spacing={0.5} alignItems="flex-start">
            <Chip
              size="sm"
              variant="plain"
              color="primary"
              slotProps={{
                action:
                  history.length > 0
                    ? { onClick: () => setExpandedInviteId(prev => (prev === invite.id ? null : invite.id)) }
                    : { sx: { pointerEvents: 'none' } },
              }}
              sx={{ fontWeight: 600 }}
            >
              {history.length} use/s
            </Chip>
            {expanded && (
              <Box>
                {history.map((entry, i) => (
                  <Typography key={`${invite.id}-usage-${i}`} level="body-xs">
                    <UsernameText id={entry.userId} /> - {formatDate(entry.usedAt)}
                  </Typography>
                ))}
              </Box>
            )}
          </Stack>
        );
      },
    },
  ];

  const rowActions = (invite: RegInviteData) => (
    <>
      <Tooltip title="Delete">
        <IconButton
          data-testid="delete-invite-code-btn"
          aria-label={`Delete code ${invite.code}`}
          size="sm"
          variant="plain"
          disabled={operating}
          onClick={() => handleDelete([invite.id])}
        >
          <DeleteOutlineIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
      <Dropdown>
        <MenuButton
          slots={{ root: IconButton }}
          slotProps={{ root: { variant: 'plain', size: 'sm', 'aria-label': `Actions for code ${invite.code}` } }}
          data-testid={`invite-row-actions-${invite.id}`}
        >
          <MoreHorizIcon sx={{ fontSize: 18 }} />
        </MenuButton>
        <Menu size="sm" placement="bottom-end">
          {[
            [RegInviteStatusType.open, 'Set open'],
            [RegInviteStatusType.waiting, 'Set waiting'],
            [RegInviteStatusType.used, 'Set used'],
          ].map(([status, text]) => (
            <MenuItem
              key={status}
              disabled={operating}
              onClick={() => handleUpdate([invite.id], status as RegInviteStatusType)}
              data-testid={`invite-set-${status}-btn`}
            >
              {text}
            </MenuItem>
          ))}
        </Menu>
      </Dropdown>
    </>
  );

  return (
    <DataTable
      label={label}
      testId="invite-table"
      rows={allInvites}
      columns={columns}
      getRowId={invite => invite.id}
      rowTestId={() => 'invite-code-card'}
      onRetry={() => undefined}
      empty={empty}
      selection={{ mode: 'explicit', ids: selected }}
      onSelectionChange={next => setSelected(next.mode === 'explicit' ? [...next.ids] : allInvites.map(i => i.id))}
      sort={{ columnId: 'createdAt', direction: sortDirection }}
      onSortChange={toggleSortDirection}
      rowActions={rowActions}
      minWidth="52rem"
      maxHeight="none"
    />
  );
};
