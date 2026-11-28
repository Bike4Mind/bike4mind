import { useState, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Divider from '@mui/joy/Divider';
import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import Skeleton from '@mui/joy/Skeleton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import type { HostEntry } from '@shared/hostConnection';
import { useHostEntries } from '../host/hostRegistry';
import { accountLine, hostAcceptsWork, hostBadgeText, hostStatusView, updateAvailable } from '../host/hostPresentation';
import { useDesktopVersion } from '../host/useDesktopVersion';
import { useHostAlias } from '../host/useSshAliases';
import { useHostOperation } from '../host/hostOperations';
import { HostActionButtons, useHostActions } from './HostActions';
import { HostErrorDetail, HostOperationNotice, HostStatusDot } from './HostStatus';

/** Everything the panel does not offer: Add and Remove belong to Settings > Connections. */
const PANEL_ACTIONS = ['connect', 'reconnect', 'disconnect', 'update', 'signIn', 'install'] as const;

function PanelRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between' }}>
      <Typography level="body-xs" textColor="text.tertiary">
        {label}
      </Typography>
      <Typography level="body-xs" data-testid={testId}>
        {value}
      </Typography>
    </Stack>
  );
}

/** The panel behind a host badge: where the connection stands, and the one-click fix for it. */
function HostPanel({
  entry,
  runningSessions,
  controller,
  onRan,
}: {
  entry: HostEntry;
  runningSessions: number;
  controller: ReturnType<typeof useHostActions>;
  onRan: () => void;
}) {
  const desktopVersion = useDesktopVersion();
  const operation = useHostOperation(entry.hostId);
  const alias = useHostAlias(entry);
  const view = hostStatusView(entry.state, desktopVersion, Date.now());
  const { state } = entry;
  return (
    <Stack spacing={1} sx={{ width: 280 }} data-testid="host-panel">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <HostStatusDot tone={view.tone} label={view.label} testId="host-panel-dot" />
        <Typography level="title-sm" sx={{ flex: 1 }} noWrap data-testid="host-panel-name">
          {entry.label}
        </Typography>
      </Stack>
      <PanelRow label="State" value={view.label} testId="host-panel-state" />
      {state.status === 'connected' && (
        <>
          <PanelRow label="Latency" value={`${Math.round(state.latencyMs)} ms`} testId="host-panel-latency" />
          <PanelRow label="Host version" value={state.info.hostVersion} testId="host-panel-version" />
          <PanelRow label="Account" value={accountLine(state.info.account)} testId="host-panel-account" />
          <PanelRow label="Running sessions" value={String(runningSessions)} testId="host-panel-running" />
        </>
      )}
      {view.detail && state.status !== 'failed' && (
        <Typography level="body-xs" textColor="text.secondary" data-testid="host-panel-detail">
          {view.detail}
        </Typography>
      )}
      {state.status === 'failed' && (
        <HostErrorDetail failure={state.failure} alias={alias} testId="host-panel-failure" />
      )}
      <HostOperationNotice operation={operation} alias={alias} testId="host-panel-operation" />
      <Divider />
      <HostActionButtons controller={controller} testIdPrefix="host-panel-action" onRan={onRan} />
    </Stack>
  );
}

/**
 * A remote project's host, as a status dot and name. Clicking opens the host panel. A host that is
 * not connected also says why in a few words. Nothing for the local host, and nothing until the
 * registry has listed the host.
 */
export function HostBadge({ hostId, runningSessions }: { hostId: string; runningSessions: number }) {
  const entry = useHostEntries().find(candidate => candidate.hostId === hostId);
  if (hostId === LOCAL_HOST_ID || !entry) return null;
  return <HostBadgeFor entry={entry} runningSessions={runningSessions} />;
}

function HostBadgeFor({ entry, runningSessions }: { entry: HostEntry; runningSessions: number }) {
  const desktopVersion = useDesktopVersion();
  const [open, setOpen] = useState(false);
  const controller = useHostActions(entry, PANEL_ACTIONS);
  const now = Date.now();
  const view = hostStatusView(entry.state, desktopVersion, now);
  const text = hostBadgeText(entry.state, desktopVersion, now);
  const tone =
    updateAvailable(entry.state, desktopVersion) && entry.state.status === 'connected' ? 'primary' : view.tone;
  return (
    <>
      <Dropdown open={open} onOpenChange={(_event, next) => setOpen(next)}>
        <MenuButton
          size="sm"
          variant="soft"
          color="neutral"
          startDecorator={<HostStatusDot tone={tone} label={view.label} testId="host-badge-dot" />}
          sx={{ '--Button-minHeight': '20px', px: 0.75, py: 0, fontSize: 11, gap: 0.5, flexShrink: 0, maxWidth: 140 }}
          slotProps={{
            root: { 'data-testid': 'host-badge', 'data-host-id': entry.hostId, 'data-status': entry.state.status },
          }}
          aria-label={`${entry.label}: ${view.label}`}
        >
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {entry.label}
            {text && (
              <Box component="span" sx={{ color: 'text.tertiary' }} data-testid="host-badge-text">{` ${text}`}</Box>
            )}
          </Box>
        </MenuButton>
        <Menu size="sm" placement="bottom-end" sx={{ p: 1.25 }} data-testid="host-panel-menu">
          <HostPanel
            entry={entry}
            runningSessions={runningSessions}
            controller={controller}
            onRan={() => setOpen(false)}
          />
        </Menu>
      </Dropdown>
      {controller.dialogs}
    </>
  );
}

/** Under a remote project that cannot be reached: its rows are the last list the host served, not live. */
export function HostStaleNote({ hostId }: { hostId: string }) {
  const entry = useHostEntries().find(candidate => candidate.hostId === hostId);
  if (hostId === LOCAL_HOST_ID || !entry || hostAcceptsWork(entry.state)) return null;
  return (
    <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1, pb: 0.25 }} data-testid="host-stale-note">
      Last known sessions. They update when {entry.label} is back.
    </Typography>
  );
}

/** Rows standing in for a host's first list, so a host still loading never reads as having no sessions. */
export function HostListPlaceholder({ hostId }: { hostId: string }) {
  const entry = useHostEntries().find(candidate => candidate.hostId === hostId);
  return (
    <Box data-testid="host-list-placeholder" data-host-id={hostId} aria-busy="true">
      <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1, fontWeight: 'lg' }}>
        {entry?.label ?? hostId}
      </Typography>
      <Stack spacing={0.75} sx={{ px: 1, py: 0.75 }}>
        {[0, 1, 2].map(index => (
          <Skeleton key={index} variant="text" level="body-sm" data-testid="host-list-placeholder-row" />
        ))}
      </Stack>
    </Box>
  );
}

/** Greys a remote project out while its host cannot take work; its sessions stay readable. */
export function HostProjectFrame({ hostId, children }: { hostId: string; children: ReactNode }) {
  const entry = useHostEntries().find(candidate => candidate.hostId === hostId);
  const offline = !!entry && !hostAcceptsWork(entry.state);
  return (
    <Box
      data-testid="host-project-frame"
      data-offline={offline ? 'true' : undefined}
      sx={{ opacity: offline ? 0.6 : 1 }}
    >
      {children}
    </Box>
  );
}

/** Where this session's work runs, beside the composer's other pills. Nothing for the local host. */
export function HostComposerChip({ hostId }: { hostId: string }) {
  const entry = useHostEntries().find(candidate => candidate.hostId === hostId);
  const desktopVersion = useDesktopVersion();
  if (hostId === LOCAL_HOST_ID || !entry) return null;
  const view = hostStatusView(entry.state, desktopVersion, Date.now());
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{ alignItems: 'center', px: 1, py: 0.25, borderRadius: 'sm', bgcolor: 'background.level1' }}
      data-testid="composer-host-chip"
      data-host-id={hostId}
    >
      <HostStatusDot tone={view.tone} label={view.label} testId="composer-host-chip-dot" />
      <Typography level="body-xs" noWrap>
        {entry.label}
      </Typography>
    </Stack>
  );
}
