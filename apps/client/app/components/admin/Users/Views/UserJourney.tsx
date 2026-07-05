import { IUserDocument, WithOrgRef } from '@bike4mind/common';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import FormatListNumberedRtlIcon from '@mui/icons-material/FormatListNumberedRtl';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Box, Button, Card, Checkbox, Grid, Stack, Tooltip, Typography } from '@mui/joy';
import React, { useState } from 'react';
import AdminProfile from '../../AdminProfile';
import CountersDetailsModal from '../Details/CountersDetails';
import LoginsView from '../LoginsView';
import MFAStatusBadge from '../MFAStatusBadge';
import MigrateAgain from '../MigrateAgain';
import { useFullUserViewModal } from '@client/app/components/admin/Users/Views/FullUserViewModal';
import { useGetUserActivityCounters } from '@client/app/hooks/data/user';

interface UserJourneyProps {
  user: WithOrgRef<IUserDocument>;
  index: number;
}

const UserJourney: React.FC<UserJourneyProps> = ({ user, index }) => {
  const setFullUserViewUserId = useFullUserViewModal(state => state.setUserId);
  const counters = useGetUserActivityCounters(user.id);
  const isCreated = !!user.createdAt;

  const [isCountersDetailsOpen, setIsCountersDetailsOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);

  const handleCountersDetailsClick = () => {
    setIsCountersDetailsOpen(true);
  };

  const handleCountersDetailsClose = () => {
    setIsCountersDetailsOpen(false);
  };

  const logins = counters.data?.find(counter => counter.action === 'numLogins')?.count ?? 0;
  const isAlert = logins === 0;

  const lastLogin =
    user.loginRecords && user.loginRecords.length > 0
      ? user.loginRecords.reduce((prev, current) => (prev.loginTime > current.loginTime ? prev : current))
      : undefined;

  return (
    <Card
      variant="outlined"
      key={index}
      sx={{
        mb: 1,
        width: '100%',
        bgcolor: index % 2 ? 'background.level1' : 'background.level2',
        p: { xs: 0.5, sm: 1 },
        overflowX: { xs: 'hidden', sm: 'visible' },
      }}
    >
      {/* Mobile compact summary */}
      <Box
        data-testid={`user-journey-mobile-summary-${index}`}
        role="button"
        tabIndex={0}
        aria-expanded={mobileExpanded}
        onClick={() => setMobileExpanded(prev => !prev)}
        sx={{
          display: { xs: 'flex', sm: 'none' },
          alignItems: 'center',
          justifyContent: 'space-between',
          p: 0.5,
          cursor: 'pointer',
        }}
      >
        <Stack direction="column" sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" fontWeight={600} noWrap>
            {user.name}
          </Typography>
          <Typography level="body-xs" color="neutral" noWrap>
            {user.email}
          </Typography>
        </Stack>
        <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', color: 'text.tertiary' }}>
          {mobileExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </Box>
      </Box>

      {/* Mobile expanded details */}
      {mobileExpanded && (
        <Box sx={{ display: { xs: 'block', sm: 'none' }, p: 1 }}>
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="body-xs" fontWeight={600} sx={{ minWidth: 80 }}>
                Org:
              </Typography>
              <Typography level="body-xs">{user.organizationId?.name || 'None'}</Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="body-xs" fontWeight={600} sx={{ minWidth: 80 }}>
                Logins:
              </Typography>
              <LoginsView user={user} />
            </Stack>
            {!lastLogin ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography level="body-xs" fontWeight={600} sx={{ minWidth: 80 }}>
                  Last Login:
                </Typography>
                <Typography level="body-xs" color="neutral" sx={{ fontStyle: 'italic' }}>
                  No login records
                </Typography>
              </Stack>
            ) : (
              <Stack spacing={0.5} sx={{ pl: 0 }}>
                <Typography level="body-xs" fontWeight={600}>
                  Last Login Details:
                </Typography>
                <Stack sx={{ pl: 1 }} spacing={0.25}>
                  <Typography level="body-xs">Time: {new Date(lastLogin.loginTime).toLocaleString()}</Typography>
                  {lastLogin.ip && <Typography level="body-xs">IP: {lastLogin.ip}</Typography>}
                  {lastLogin.deviceType && <Typography level="body-xs">Device: {lastLogin.deviceType}</Typography>}
                  {lastLogin.browser && <Typography level="body-xs">Browser: {lastLogin.browser}</Typography>}
                  {lastLogin.operatingSystem && (
                    <Typography level="body-xs">OS: {lastLogin.operatingSystem}</Typography>
                  )}
                  {lastLogin.screenResolution && (
                    <Typography level="body-xs">Screen: {lastLogin.screenResolution}</Typography>
                  )}
                  {lastLogin.location && <Typography level="body-xs">Location: {lastLogin.location}</Typography>}
                </Stack>
              </Stack>
            )}
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="body-xs" fontWeight={600} sx={{ minWidth: 80 }}>
                Created:
              </Typography>
              <Checkbox checked={isCreated} disabled size="sm" />
              <Typography level="body-xs">
                {user.createdAt ? new Date(user.createdAt).toDateString() : '- - -'}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="body-xs" fontWeight={600} sx={{ minWidth: 80 }}>
                Security:
              </Typography>
              <MFAStatusBadge user={user} />
            </Stack>
            <Stack direction="row" sx={{ pt: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
              <Button size="sm" onClick={() => setFullUserViewUserId(user.id)}>
                Admin
              </Button>
              <AdminProfile userId={user.id} size="sm" />
              {isAlert && <MigrateAgain user={user} size="sm" />}
            </Stack>
            <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
              <Button
                size="sm"
                variant="plain"
                onClick={handleCountersDetailsClick}
                startDecorator={<FormatListNumberedRtlIcon />}
              >
                Counters
              </Button>
            </Stack>
          </Stack>
        </Box>
      )}

      {/* Desktop full grid - hidden on mobile */}
      <Box sx={{ display: { xs: 'none', sm: 'block' }, overflowX: 'visible' }}>
        <Grid container spacing={1} sx={{ width: '100%', minWidth: 'auto' }} alignItems={'center'}>
          {/* Name, Email, Organization */}
          <Grid xs={2}>
            <Tooltip title={user.name} arrow>
              <Typography level="body-xs">{user.name}</Typography>
            </Tooltip>
            <Tooltip title={user.email} arrow>
              <Typography level="body-xs" sx={{ wordBreak: 'break-all' }}>
                {user.email}
              </Typography>
            </Tooltip>
          </Grid>
          <Grid xs={1}>
            <Tooltip title={user.organizationId?.name} arrow>
              <Typography level="body-xs">{user.organizationId?.name}</Typography>
            </Tooltip>
          </Grid>

          <Grid xs={1}>
            <LoginsView user={user} />
          </Grid>

          <Grid xs={1}>
            <Tooltip title="User has been created" arrow>
              <Box>
                <Checkbox checked={isCreated} disabled />
                <AutoFixHighIcon />
                {user.createdAt && <Typography level="body-xs">{new Date(user.createdAt).toDateString()}</Typography>}
              </Box>
            </Tooltip>
          </Grid>
          <Grid xs={1}>
            <Tooltip title="User Counters" arrow>
              <Button
                startDecorator={<FormatListNumberedRtlIcon />}
                size="lg"
                variant="plain"
                onClick={handleCountersDetailsClick}
              />
            </Tooltip>
          </Grid>

          <Grid xs={0.5}>
            <MFAStatusBadge user={user} />
          </Grid>
          {/* Action Buttons Group */}
          <Grid xs={3} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Button size="sm" onClick={() => setFullUserViewUserId(user.id)}>
              Admin
            </Button>
            <AdminProfile userId={user.id} size="sm" />
            {isAlert && <MigrateAgain user={user} size="sm" />}
          </Grid>
        </Grid>
      </Box>

      <CountersDetailsModal open={isCountersDetailsOpen} onClose={handleCountersDetailsClose} userId={user.id} />
    </Card>
  );
};

export default UserJourney;
