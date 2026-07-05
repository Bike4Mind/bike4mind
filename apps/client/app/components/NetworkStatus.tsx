import React, { FC, useState, useEffect } from 'react';
import { ReadyState, useWebsocket } from '@/app/contexts/WebsocketContext';
import { Box, IconButton, Tooltip, Typography, useTheme } from '@mui/joy';
import type { Theme } from '@mui/joy/styles';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import PendingIcon from '@mui/icons-material/Pending';
import CircleLoader from 'react-spinners/CircleLoader';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import BugReportIcon from '@mui/icons-material/BugReport';
import NotificationsOffIcon from '@mui/icons-material/NotificationsOff';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useUser } from '@client/app/contexts/UserContext';
import { api } from '@client/app/contexts/ApiContext';
import {
  toggleSerwistSuppression,
  getSerwistSuppressionPreference,
  setSerwistSuppressionPreference,
} from '@client/app/utils/suppressSerwistWarnings';
import { setServiceWorkerDisabled } from '@client/app/utils/disableServiceWorker';
import { resolveWsDebugChipVisible } from '@client/app/utils/wsDebugChip';

interface IProps {}

type ServiceState = 'ok' | 'bad' | 'pending';

/** One line in the connected-services checklist tooltip. */
const ServiceRow: FC<{ state: ServiceState; label: string; status: string; okColor?: string }> = ({
  state,
  label,
  status,
  okColor,
}) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
    {state === 'ok' ? (
      <CheckCircleIcon sx={{ fontSize: '14px', color: okColor ?? '#1FB84B' }} />
    ) : state === 'pending' ? (
      <RadioButtonUncheckedIcon sx={{ fontSize: '14px', opacity: 0.5 }} />
    ) : (
      <CancelIcon sx={{ fontSize: '14px', opacity: 0.5 }} />
    )}
    <Typography level="body-xs" sx={{ color: 'inherit', whiteSpace: 'nowrap' }}>
      {label}: {status}
    </Typography>
  </Box>
);

const NetworkStatus: FC<IProps> = () => {
  const { readyState, activeSubscriptions, clientId } = useWebsocket();
  const theme = useTheme();
  const { t } = useTranslation();
  const isDeveloper = useUser(s => s.isDeveloper || s.isAdmin);

  // Poll the always-on QuestProcessorService web server (via the VPC-internal /health proxy)
  // so the cloud-icon tooltip can show it alongside the websocket as a connected-services
  // checklist. The 15s poll is itself the retry cadence - no per-request retries on a down service.
  const { data: questProcessor, isLoading: questProcessorLoading } = useQuery<{ connected: boolean }>({
    queryKey: ['quest-processor', 'status'],
    queryFn: async () => (await api.get<{ connected: boolean }>('/api/quest-processor-status')).data,
    refetchInterval: 15000,
    retry: false,
    staleTime: 10000,
  });
  const [serwistSuppressed, setSerwistSuppressed] = useState(true);
  // WS subscription chip is implementation detail - opt-in via ?debug=ws so engineers
  // can surface it on any env without leaking it to admins/end users by default. Resolved
  // client-side after mount: ?debug=ws sticks in sessionStorage so the chip survives
  // SPA navigation that drops the query param; ?debug=off clears it. Starting false also
  // keeps the chip client-only with no SSR/hydration mismatch.
  const [showWsDebugChip, setShowWsDebugChip] = useState(false);

  useEffect(() => {
    const suppressed = getSerwistSuppressionPreference();
    setSerwistSuppressed(suppressed);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setShowWsDebugChip(resolveWsDebugChipVisible(window.location.search));
  }, []);

  const handleToggleSerwist = () => {
    const newState = toggleSerwistSuppression();
    setSerwistSuppressed(newState);
    setSerwistSuppressionPreference(newState);

    // Also disable the service worker entirely when suppressing
    setServiceWorkerDisabled(newState);

    // Force a console message to test if suppression is working
    if (process.env.NODE_ENV === 'development') {
      console.log(`Serwist suppression is now ${newState ? 'ON (warnings hidden)' : 'OFF (warnings visible)'}`);
      if (newState) {
        console.log('Service worker will be disabled on next page load');
      }
    }
  };

  const stateIcons = {
    [ReadyState.UNINSTANTIATED]: <PendingIcon sx={{ fontSize: '16px' }} />,
    [ReadyState.CONNECTING]: <CircleLoader size={14} color={theme.palette.neutral.softColor} />,
    [ReadyState.OPEN]: <CloudDoneIcon sx={{ fontSize: '16px' }} />,
    [ReadyState.CLOSING]: <CloudDownloadIcon sx={{ fontSize: '16px' }} />,
    [ReadyState.CLOSED]: <CloudOffIcon sx={{ fontSize: '16px' }} />,
  };

  // Footer chips are monochrome (brand light-blue); only the cloud ICON turns green
  // (#1FB84B) when the socket is OPEN. The chip border stays neutral in every state.
  const isCloudOpen = readyState === ReadyState.OPEN;

  // Connected-services checklist (shown in the cloud icon's tooltip). The cloud icon itself
  // still reflects the websocket; the tooltip enumerates every backend the session depends on.
  const websocketState: ServiceState = isCloudOpen
    ? 'ok'
    : readyState === ReadyState.CONNECTING || readyState === ReadyState.UNINSTANTIATED
      ? 'pending'
      : 'bad';
  const questProcessorState: ServiceState = questProcessorLoading
    ? 'pending'
    : questProcessor?.connected
      ? 'ok'
      : 'bad';
  const questProcessorStatusKey = questProcessorLoading
    ? 'checking'
    : questProcessor?.connected
      ? 'connected'
      : 'disconnected';

  const servicesTooltip = (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, py: 0.25 }}>
      <Typography level="body-xs" sx={{ color: 'inherit', fontWeight: 'lg' }}>
        {t('network.servicesTitle')}
      </Typography>
      <ServiceRow
        state={websocketState}
        label={t('network.services.websocket')}
        status={t(`network.statuses.${readyState}`)}
        okColor={theme.palette.sidenav?.chipIconConnected}
      />
      <ServiceRow
        state={questProcessorState}
        label={t('network.services.questProcessor')}
        status={t(`questProcessor.statuses.${questProcessorStatusKey}`)}
        okColor={theme.palette.sidenav?.chipIconConnected}
      />
    </Box>
  );
  const pillSx = (theme: Theme) => ({
    border: `1px solid ${theme.palette.neutral.outlinedBorder}`,
    backgroundColor: 'transparent',
    height: '24px',
    minHeight: '24px',
    minWidth: '40px',
    px: '10px',
    borderRadius: '8px',
    fontFamily: 'code',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0.5,
    // Monochrome chips: text in brand light-blue, icons at 50% (Joy icons read --Icon-color).
    color: theme.palette.sidenav?.chipText,
    '--Icon-color': theme.palette.sidenav?.chipIcon,
  });

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      {isDeveloper && process.env.NODE_ENV === 'development' && (
        <Tooltip
          title={
            serwistSuppressed
              ? 'Serwist warnings suppressed (click to show)'
              : 'Serwist warnings visible (click to hide)'
          }
        >
          <Box
            onClick={handleToggleSerwist}
            sx={theme => ({
              ...pillSx(theme),
              cursor: 'pointer',
              transition: 'all 0.2s',
              '&:hover': {
                backgroundColor: theme.palette.neutral.outlinedHoverBg,
                borderColor: theme.palette.neutral.outlinedHoverBorder,
              },
            })}
          >
            {serwistSuppressed ? (
              <NotificationsOffIcon sx={{ fontSize: '14px' }} />
            ) : (
              <BugReportIcon sx={{ fontSize: '14px' }} />
            )}
            <Typography level="body-xs" sx={{ color: 'inherit' }}>
              SW: {serwistSuppressed ? 'Off' : 'On'}
            </Typography>
          </Box>
        </Tooltip>
      )}

      {showWsDebugChip && (
        <Tooltip title="Active WebSocket Subscriptions / Client ID">
          <Box sx={pillSx}>
            <AccountTreeIcon sx={{ fontSize: '14px' }} />
            <Typography level="body-xs" component="span" sx={{ color: 'inherit' }}>
              WS: {activeSubscriptions?.size || 0}
            </Typography>
            {clientId && (
              <Typography level="body-xs" component="span" sx={{ color: 'inherit', opacity: 0.7 }}>
                ID: {clientId.slice(0, 6)}
              </Typography>
            )}
          </Box>
        </Tooltip>
      )}
      <Tooltip title={servicesTooltip}>
        <IconButton
          variant={'outlined'}
          color={'neutral'}
          data-testid="network-status-btn"
          sx={{
            '--IconButton-size': '24px',
            minHeight: '24px',
            minWidth: '40px',
            borderRadius: '8px',
            // Icon-only color: green when connected, brand light-blue @50% otherwise.
            // The border stays neutral in every state.
            '--Icon-color': isCloudOpen ? theme.palette.sidenav?.chipIconConnected : theme.palette.sidenav?.chipIcon,
          }}
        >
          {stateIcons[readyState]}
        </IconButton>
      </Tooltip>
    </Box>
  );
};

export default NetworkStatus;
