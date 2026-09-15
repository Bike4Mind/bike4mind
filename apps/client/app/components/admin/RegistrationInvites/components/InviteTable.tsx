import { ChangeEvent, useState } from 'react';
import { Box, Card, Checkbox, Chip, Divider, Grid, IconButton, Sheet, Stack, Tooltip, Typography } from '@mui/joy';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import CircleIcon from '@mui/icons-material/Circle';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import HourglassBottomIcon from '@mui/icons-material/HourglassBottom';
import AllInclusiveIcon from '@mui/icons-material/AllInclusive';
import { RegInviteStatusType } from '@bike4mind/common';
import UsernameText from '../../../common/UsernameText';
import { getTagColor } from '../../InviteCenter/shared/tagColors';
import { InviteTableProps } from '../types';

export const InviteTable: React.FC<InviteTableProps> = ({
  invites,
  allInvites,
  borderColor,
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
}) => {
  const isMobile = useIsMobile();
  const [now] = useState(() => Date.now());
  const [expandedInviteId, setExpandedInviteId] = useState<string | null>(null);
  const allItemsSelected = allInvites.length > 0 && allInvites.every(invite => selected.includes(invite.id));
  const onAllCheckboxClick = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      setSelected(allInvites.map(i => i.id));
    } else {
      setSelected([]);
    }
  };

  const onCheckboxClick = (_: ChangeEvent<HTMLInputElement>, id: string) => {
    if (selected.includes(id)) {
      setSelected(prev => prev.filter(i => i !== id));
    } else {
      setSelected(prev => [...prev, id]);
    }
  };

  const usageHistoryBlock = (regInvite: (typeof invites)[number]) =>
    regInvite.unlimitedUse &&
    expandedInviteId === regInvite.id &&
    regInvite.usageHistory &&
    regInvite.usageHistory.length > 0 ? (
      <Box sx={{ bgcolor: 'background.level1', borderRadius: 'sm', px: 2, py: 1.5, mb: 1 }}>
        <Stack spacing={0.5}>
          <Typography level="body-sm" sx={{ fontWeight: 600, mb: 0.5 }}>
            Usage history
          </Typography>
          {regInvite.usageHistory.map((entry, i) => (
            <Stack direction="row" key={`${regInvite.id}-usage-${i}`} spacing={1} alignItems="center">
              <Typography color="primary" level="body-xs" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <UsernameText id={entry.userId} />
              </Typography>
              <Typography level="body-xs">•</Typography>
              <Typography level="body-xs" color="primary">
                {formatDate(entry.usedAt)}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Box>
    ) : null;

  const tagRow = (regInvite: (typeof invites)[number]) =>
    (regInvite.tags && regInvite.tags.length > 0) || regInvite.startingCredits || regInvite.startingStorage ? (
      <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
        {regInvite.tags?.map(tag => (
          <Chip
            key={tag}
            size="sm"
            variant="soft"
            sx={{ bgcolor: getTagColor(tag) + '22', color: getTagColor(tag), fontSize: '0.65rem' }}
          >
            {tag}
          </Chip>
        ))}
        {regInvite.startingCredits != null && regInvite.startingCredits > 0 && (
          <Chip size="sm" variant="soft" color="success" sx={{ fontSize: '0.65rem' }}>
            {regInvite.startingCredits} credits
          </Chip>
        )}
        {regInvite.startingStorage != null && regInvite.startingStorage > 0 && (
          <Chip size="sm" variant="soft" color="primary" sx={{ fontSize: '0.65rem' }}>
            {regInvite.startingStorage} MB
          </Chip>
        )}
      </Stack>
    ) : null;

  const statusLabel = (regInvite: (typeof invites)[number]) =>
    regInvite.unlimitedUse && regInvite.expiresAt
      ? new Date(regInvite.expiresAt).getTime() < now
        ? 'expired'
        : regInvite.status
      : regInvite.status;

  if (isMobile) {
    return (
      <Stack spacing={1} sx={{ my: 2 }}>
        {/* Select-all checkbox row */}
        <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 0.5 }}>
          <Checkbox size="sm" checked={allItemsSelected} onChange={onAllCheckboxClick} />
          <Typography level="body-xs" fontWeight={600}>
            Select all ({allInvites.length})
          </Typography>
        </Stack>
        {invites.map((regInvite, index) => (
          <Box key={regInvite.code}>
            <Card
              variant="outlined"
              data-testid="invite-code-card"
              sx={{
                bgcolor: index % 2 ? 'background.level1' : 'background.level2',
                borderLeft: `3px solid ${borderColor}`,
                p: 1.5,
              }}
            >
              <Stack spacing={1}>
                {/* Code + status row */}
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Checkbox
                      checked={selected.includes(regInvite.id)}
                      onChange={e => onCheckboxClick(e, regInvite.id)}
                      size="sm"
                    />
                    <Tooltip color={copied ? 'success' : 'primary'} title={copied ? 'Copied!' : 'Click to Copy'}>
                      <Typography
                        data-testid="invite-code-value"
                        color="primary"
                        level="body-xs"
                        sx={{ cursor: 'copy', fontFamily: 'monospace' }}
                        onClick={() => copyToClipboard(regInvite.code)}
                      >
                        {regInvite.code}
                      </Typography>
                    </Tooltip>
                  </Stack>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Typography color="primary" level="body-xs">
                      {statusLabel(regInvite)}
                    </Typography>
                    {regInvite.unlimitedUse && regInvite.expiresAt && (
                      <Tooltip title={`Expiry Date: ${formatDate(regInvite.expiresAt)}`} size="sm" color="success">
                        <Chip
                          size="sm"
                          color="success"
                          sx={{ lineHeight: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <AllInclusiveIcon sx={{ fontSize: '1rem' }} />
                        </Chip>
                      </Tooltip>
                    )}
                  </Stack>
                </Stack>
                {/* Details */}
                <Stack spacing={0.25}>
                  <Typography level="body-xs">
                    Created by: {regInvite.userId ? <UsernameText id={regInvite.userId} /> : 'Unknown'}
                  </Typography>
                  <Typography level="body-xs">Created: {formatDate(regInvite.createdAt)}</Typography>
                  {regInvite.unlimitedUse ? (
                    <Chip
                      size="sm"
                      variant="plain"
                      color="primary"
                      onClick={event => {
                        if (!regInvite.usageHistory || regInvite.usageHistory.length === 0) return;
                        event.stopPropagation();
                        setExpandedInviteId(prev => (prev === regInvite.id ? null : regInvite.id));
                      }}
                      sx={{
                        cursor: regInvite.usageHistory && regInvite.usageHistory.length > 0 ? 'pointer' : 'default',
                        alignSelf: 'flex-start',
                        fontWeight: 600,
                      }}
                    >
                      {(regInvite.usageHistory?.length ?? 0).toString()} use/s
                    </Chip>
                  ) : regInvite.usedbyId ? (
                    <Typography level="body-xs">
                      Used by: <UsernameText id={regInvite.usedbyId} />
                    </Typography>
                  ) : null}
                </Stack>
                {tagRow(regInvite)}
                <Divider />
                {/* Actions */}
                <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                  <Tooltip color="primary" title="Set Open">
                    <IconButton
                      onClick={() => handleUpdate([regInvite.id], RegInviteStatusType.open)}
                      color="primary"
                      disabled={operating}
                      size="sm"
                    >
                      <CircleIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip color="warning" title="Set Waiting">
                    <IconButton
                      onClick={() => handleUpdate([regInvite.id], RegInviteStatusType.waiting)}
                      color="warning"
                      disabled={operating}
                      size="sm"
                    >
                      <HourglassBottomIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip color="success" title="Set Used">
                    <IconButton
                      onClick={() => handleUpdate([regInvite.id], RegInviteStatusType.used)}
                      color="success"
                      disabled={operating}
                      size="sm"
                    >
                      <CloseFullscreenIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip color="danger" title="Delete">
                    <IconButton
                      data-testid="delete-invite-code-btn"
                      disabled={operating}
                      onClick={() => handleDelete([regInvite.id])}
                      color="danger"
                      size="sm"
                    >
                      <DeleteForeverIcon />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
            </Card>
            {usageHistoryBlock(regInvite)}
          </Box>
        ))}
      </Stack>
    );
  }

  return (
    <>
      <Sheet
        sx={{
          overflowY: 'auto',
          width: '100%',
          overflowX: { xs: 'auto', sm: 'hidden' },
          my: 2,
          '&:hover': {
            overflowY: 'auto',
          },
          '&::-webkit-scrollbar': {
            width: '8px',
            backgroundColor: 'background.level1',
          },
          '&::-webkit-scrollbar-thumb': {
            backgroundColor: 'neutral.400',
            borderRadius: '4px',
            '&:hover': {
              backgroundColor: 'neutral.500',
            },
          },
          '&::-webkit-scrollbar-track': {
            backgroundColor: 'background.level1',
          },
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--joy-palette-neutral-400) var(--joy-palette-background-level1)',
          '&::-webkit-scrollbar-thumb:vertical': {
            minHeight: '30px',
          },
          paddingRight: '4px',
        }}
      >
        <Grid xs={12} sm={12} md={12}>
          <Box sx={{ ml: '1em', mb: '0.2em', overflowX: { xs: 'auto', sm: 'visible' } }}>
            <Grid container sx={{ minWidth: { xs: '900px', sm: 'auto' } }}>
              <Grid xs={3}>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                  <Checkbox size={'sm'} sx={{ mr: '0.3em' }} checked={allItemsSelected} onChange={onAllCheckboxClick} />
                  <Typography sx={{ color: 'primary', fontWeight: 600 }} level="body-xs">
                    Code
                  </Typography>
                </Box>
              </Grid>
              <Grid xs={2}>
                <Typography sx={{ color: 'primary', fontWeight: 600 }} level="body-xs">
                  Created By
                </Typography>
              </Grid>
              <Grid xs={2}>
                <Typography
                  sx={{
                    color: 'primary',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    '&:hover': { textDecoration: 'underline' },
                  }}
                  level="body-xs"
                  onClick={toggleSortDirection}
                >
                  Created At {sortDirection === 'desc' ? '↓' : '↑'}
                </Typography>
              </Grid>
              <Grid xs={1.5}>
                <Typography sx={{ color: 'primary', fontWeight: 600 }} level="body-xs">
                  Status
                </Typography>
              </Grid>
              <Grid xs={1.5}>
                <Typography sx={{ color: 'primary', fontWeight: 600 }} level="body-xs">
                  Used by
                </Typography>
              </Grid>
              <Grid xs={2}>
                <Box width={'100%'} display={'flex'} justifyContent={'end'} pr={'3em'}>
                  <Typography sx={{ color: 'primary', fontWeight: 600 }} level="body-xs">
                    ACTIONS
                  </Typography>
                </Box>
              </Grid>
            </Grid>
          </Box>
        </Grid>

        {invites.map((regInvite, index) => (
          <Grid xs={12} sm={12} md={12} key={regInvite.code}>
            <Card
              variant="outlined"
              data-testid="invite-code-card"
              sx={{
                mb: '0.3em',
                bgcolor: index % 2 ? 'background.level1' : 'background.level2',
                borderLeft: `3px solid ${borderColor}`,
                overflowX: { xs: 'auto', sm: 'visible' },
              }}
            >
              <Grid container spacing={1} sx={{ minWidth: { xs: '900px', sm: 'auto' } }}>
                <Grid xs={3}>
                  <Stack
                    direction="row"
                    spacing={1}
                    sx={{ cursor: 'copy' }}
                    onClick={() => copyToClipboard(regInvite.code)}
                  >
                    <Checkbox
                      checked={selected.includes(regInvite.id)}
                      onChange={e => onCheckboxClick(e, regInvite.id)}
                    />
                    <Tooltip color={copied ? 'success' : 'primary'} title={copied ? 'Copied!' : 'Click to Copy'}>
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Typography data-testid="invite-code-value" color="primary" level="body-xs">
                          {regInvite.code}
                        </Typography>
                      </Stack>
                    </Tooltip>
                  </Stack>
                </Grid>
                <Grid xs={2}>
                  <Typography color="primary" level="body-xs">
                    {regInvite.userId ? <UsernameText id={regInvite.userId} /> : 'Unknown'}
                  </Typography>
                </Grid>
                <Grid xs={2}>
                  <Typography color="primary" level="body-xs">
                    {formatDate(regInvite.createdAt)}
                  </Typography>
                </Grid>
                <Grid xs={1.5}>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Typography color="primary" level="body-xs">
                      {statusLabel(regInvite)}
                    </Typography>
                    {regInvite.unlimitedUse && regInvite.expiresAt && (
                      <Tooltip title={`Expiry Date: ${formatDate(regInvite.expiresAt)}`} size="sm" color="success">
                        <Chip
                          size="sm"
                          color="success"
                          sx={{
                            lineHeight: 0,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <AllInclusiveIcon sx={{ fontSize: '1rem' }} />
                        </Chip>
                      </Tooltip>
                    )}
                  </Stack>
                </Grid>
                <Grid xs={1.5}>
                  {regInvite.unlimitedUse ? (
                    <Chip
                      size="sm"
                      variant="plain"
                      color="primary"
                      onClick={event => {
                        if (!regInvite.usageHistory || regInvite.usageHistory.length === 0) return;
                        event.stopPropagation();
                        setExpandedInviteId(prev => (prev === regInvite.id ? null : regInvite.id));
                      }}
                      sx={{
                        cursor: regInvite.usageHistory && regInvite.usageHistory.length > 0 ? 'pointer' : 'default',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 0.4,
                        px: 0.9,
                        fontWeight: 600,
                      }}
                    >
                      {(regInvite.usageHistory?.length ?? 0).toString()} use/s
                    </Chip>
                  ) : (
                    <Typography color="primary" level="body-xs">
                      {regInvite.usedbyId ? <UsernameText id={regInvite.usedbyId} /> : ''}
                    </Typography>
                  )}
                </Grid>
                <Grid xs={2}>
                  <Box height={'15px'} width={'100%'} display={'flex'} justifyContent={'end'} mt={'-7px'} gap={'10px'}>
                    <Tooltip color={'primary'} title="Set Open">
                      <IconButton
                        onClick={() => handleUpdate([regInvite.id], RegInviteStatusType.open)}
                        color={'primary'}
                        disabled={operating}
                        size={'sm'}
                      >
                        <CircleIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip color={'warning'} title="Set Waiting">
                      <IconButton
                        onClick={() => handleUpdate([regInvite.id], RegInviteStatusType.waiting)}
                        color={'warning'}
                        disabled={operating}
                        size={'sm'}
                      >
                        <HourglassBottomIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip color={'success'} title="Set Used">
                      <IconButton
                        onClick={() => handleUpdate([regInvite.id], RegInviteStatusType.used)}
                        color={'success'}
                        disabled={operating}
                        size={'sm'}
                      >
                        <CloseFullscreenIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip color={'danger'} title="Delete">
                      <IconButton
                        data-testid="delete-invite-code-btn"
                        disabled={operating}
                        onClick={() => handleDelete([regInvite.id])}
                        color={'danger'}
                        size={'sm'}
                      >
                        <DeleteForeverIcon />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Grid>
                {((regInvite.tags && regInvite.tags.length > 0) ||
                  regInvite.startingCredits ||
                  regInvite.startingStorage) && (
                  <Grid xs={12}>
                    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" sx={{ mt: -0.5 }}>
                      {regInvite.tags?.map(tag => (
                        <Chip
                          key={tag}
                          size="sm"
                          variant="soft"
                          sx={{ bgcolor: getTagColor(tag) + '22', color: getTagColor(tag), fontSize: '0.65rem' }}
                        >
                          {tag}
                        </Chip>
                      ))}
                      {regInvite.startingCredits != null && regInvite.startingCredits > 0 && (
                        <Chip size="sm" variant="soft" color="success" sx={{ fontSize: '0.65rem' }}>
                          {regInvite.startingCredits} credits
                        </Chip>
                      )}
                      {regInvite.startingStorage != null && regInvite.startingStorage > 0 && (
                        <Chip size="sm" variant="soft" color="primary" sx={{ fontSize: '0.65rem' }}>
                          {regInvite.startingStorage} MB
                        </Chip>
                      )}
                    </Stack>
                  </Grid>
                )}
              </Grid>
            </Card>
            {regInvite.unlimitedUse &&
              expandedInviteId === regInvite.id &&
              regInvite.usageHistory &&
              regInvite.usageHistory.length > 0 && (
                <Grid xs={12}>
                  <Box
                    sx={{
                      bgcolor: 'background.level1',
                      borderRadius: 'sm',
                      px: 2,
                      py: 1.5,
                      mb: 1,
                    }}
                  >
                    <Stack spacing={0.5}>
                      <Typography level="body-sm" sx={{ fontWeight: 600, mb: 0.5 }}>
                        Usage history
                      </Typography>
                      {regInvite.usageHistory.map((entry, index) => (
                        <Stack direction="row" key={`${regInvite.id}-usage-${index}`} spacing={1} alignItems="center">
                          <Typography
                            color="primary"
                            level="body-xs"
                            sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
                          >
                            <UsernameText id={entry.userId} />
                          </Typography>
                          <Typography level="body-xs">•</Typography>
                          <Typography level="body-xs" color="primary">
                            {formatDate(entry.usedAt)}
                          </Typography>
                        </Stack>
                      ))}
                    </Stack>
                  </Box>
                </Grid>
              )}
          </Grid>
        ))}
      </Sheet>
    </>
  );
};
