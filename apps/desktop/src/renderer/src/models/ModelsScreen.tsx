import { useEffect, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import LinearProgress from '@mui/joy/LinearProgress';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Tab from '@mui/joy/Tab';
import TabList from '@mui/joy/TabList';
import TabPanel from '@mui/joy/TabPanel';
import Tabs from '@mui/joy/Tabs';
import Typography from '@mui/joy/Typography';
import { LOCAL_SERVER_ID, LOCAL_SERVER_NAME, serverManagement, type ModelServerView } from '@shared/modelServers';
import { OLLAMA_DOWNLOAD_URL, type ModelPull, type ModelRuntimeStatus } from '@shared/models';
import { ExternalLink } from '../chat/ExternalLink';
import { CloseIcon } from '../chat/icons';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from '../chat/layout';
import { ExploreTab } from './ExploreTab';
import { InstalledTab, type ModelsInUse } from './InstalledTab';
import { manageNote, type ModelTarget } from './modelTarget';
import { pullLabel, pullPercent } from './pullDisplay';
import { ServerSwitcher } from './ServerSwitcher';
import { useModelHub, useModelServers } from './useModelHub';

// A Curated tab, fed by a signed manifest, goes first in this list when it lands.
type ModelsTab = 'installed' | 'explore';

const screenColumnSx = { ...contentColumnSx, maxWidth: 1120 };

// Survive leaving the screen, so coming back mid-pull lands where the user was.
let rememberedTab: ModelsTab = 'installed';
let rememberedServer = LOCAL_SERVER_ID;

const dot = (color: string) => <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />;

function RuntimeStatusBar({
  status,
  target,
  onRetry,
}: {
  status: ModelRuntimeStatus | null;
  target: ModelTarget;
  onRetry: () => void;
}) {
  if (!status)
    return (
      <Typography level="body-sm" textColor="text.tertiary" data-testid="models-runtime-status" data-state="checking">
        {target.local ? 'Checking for Ollama...' : `Checking ${target.name}...`}
      </Typography>
    );
  const address = <Typography fontFamily="code">{status.url.replace(/^https?:\/\//, '')}</Typography>;
  if (status.reachable)
    return (
      <Stack direction="row" alignItems="center" spacing={1} data-testid="models-runtime-status" data-state="running">
        {dot('success.500')}
        <Typography level="body-sm">
          {target.local ? (
            <>Ollama {status.version ?? ''} running at </>
          ) : target.management === 'unsupported' ? (
            <>{target.name}, an OpenAI-compatible server, at </>
          ) : (
            <>
              Ollama {status.version ?? ''} on {target.name} at{' '}
            </>
          )}
          {address}
        </Typography>
      </Stack>
    );
  return (
    <Stack direction="row" alignItems="center" spacing={1} data-testid="models-runtime-status" data-state="down">
      {dot('danger.500')}
      <Typography level="body-sm" sx={{ flex: 1 }}>
        {target.local ? (
          <>
            Ollama is not running on this computer. Start it, or install it from{' '}
            <ExternalLink href={OLLAMA_DOWNLOAD_URL} testId="models-runtime-download-link">
              ollama.com/download
            </ExternalLink>
            .
          </>
        ) : (
          (status.error ?? `Could not reach ${target.name}.`)
        )}
      </Typography>
      <Button size="sm" variant="outlined" color="neutral" onClick={onRetry} data-testid="models-runtime-retry-btn">
        Check again
      </Button>
    </Stack>
  );
}

function PullRow({ pull }: { pull: ModelPull }) {
  const failed = pull.phase === 'failed';
  const paused = pull.phase === 'paused';
  const remote = pull.serverId !== LOCAL_SERVER_ID;
  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'md', px: 1.5, py: 1 }}
      data-testid="models-pull-row"
      data-key={pull.key}
      data-phase={pull.phase}
      data-server={pull.serverId}
    >
      <Stack direction="row" alignItems="center" spacing={1}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" fontFamily="code" noWrap>
            {pull.repo} {pull.quant ?? ''}
            {remote && (
              <Typography fontFamily="body" textColor="text.tertiary">
                {' '}
                to {pull.serverName}
              </Typography>
            )}
          </Typography>
          <Typography
            level="body-xs"
            color={failed ? 'danger' : paused ? 'warning' : 'neutral'}
            data-testid="models-pull-status"
            sx={{ mt: 0.25 }}
          >
            {pullLabel(pull)}
          </Typography>
          {paused && pull.error && (
            <Typography level="body-xs" data-testid="models-pull-paused-note" sx={{ mt: 0.25 }}>
              {pull.error.message}
            </Typography>
          )}
          {remote && !failed && !paused && (
            <Typography level="body-xs" textColor="text.tertiary" data-testid="models-pull-keep-open" sx={{ mt: 0.25 }}>
              Keep Bike4Mind open until it finishes.
            </Typography>
          )}
        </Box>
        {paused && (
          <Button
            size="sm"
            variant="soft"
            onClick={() => void window.b4m.models.resumePull(pull.key)}
            data-testid="models-pull-resume-btn"
          >
            Resume
          </Button>
        )}
        {failed || paused ? (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => void window.b4m.models.dismissPull(pull.key)}
            data-testid="models-pull-dismiss-btn"
          >
            Dismiss
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={() => void window.b4m.models.cancelPull(pull.key)}
            data-testid="models-pull-cancel-btn"
          >
            Cancel
          </Button>
        )}
      </Stack>
      {!failed && (
        <LinearProgress
          determinate={pull.phase === 'downloading' || paused}
          value={pullPercent(pull)}
          aria-label={`Download of ${pull.repo} ${pull.quant ?? pull.buildId}`}
          aria-valuetext={pullLabel(pull)}
          sx={{ mt: 1 }}
          data-testid="models-pull-progress"
        />
      )}
    </Sheet>
  );
}

function targetOf(serverId: string, servers: ModelServerView[] | null, status: ModelRuntimeStatus | null): ModelTarget {
  const server = servers?.find(candidate => candidate.id === serverId);
  const local = serverId === LOCAL_SERVER_ID;
  return {
    id: serverId,
    name: local ? LOCAL_SERVER_NAME : (server?.name ?? status?.serverName ?? 'Model server'),
    local,
    // The live list follows Settings at once; main checks every pull and removal against the same settings.
    management: server
      ? serverManagement(server)
      : status?.serverId === serverId
        ? status.management
        : local
          ? 'allowed'
          : 'chat-only',
  };
}

/** Open models on this computer or a saved model server: what is installed, and GGUF builds to download. */
export function ModelsScreen({ onClose, inUse }: { onClose: () => void; inUse?: ModelsInUse }) {
  const servers = useModelServers();
  const [chosenServer, setChosenServer] = useState(rememberedServer);
  // A server removed in Settings falls back to this computer.
  const serverId = servers && !servers.some(server => server.id === chosenServer) ? LOCAL_SERVER_ID : chosenServer;
  const hub = useModelHub(serverId);
  const [tab, setTab] = useState<ModelsTab>(rememberedTab);
  const choose = (next: ModelsTab) => {
    rememberedTab = next;
    setTab(next);
  };
  const chooseServer = (next: string) => {
    rememberedServer = next;
    setChosenServer(next);
  };
  const target = targetOf(serverId, servers, hub.status);
  const status = hub.status?.serverId === serverId ? hub.status : null;
  const { refresh } = hub;
  const statusManagement = status?.management;
  useEffect(() => {
    // Settings changed the server's access or kind: what main reports about it changes too.
    if (statusManagement && statusManagement !== target.management) void refresh();
  }, [statusManagement, target.management, refresh]);
  const installedCount = status && hub.installed?.ok ? hub.installed.models.length : null;
  const note = manageNote(target);

  return (
    <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }} data-testid="models-screen">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...screenColumnSx, py: 1.25 }}>
          <Stack sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="title-sm" component="h1">
              Models
            </Typography>
            <Typography level="body-xs" textColor="text.tertiary">
              {target.local
                ? 'Run open models on this computer with Ollama. Nothing downloads until you confirm it.'
                : `Open models on ${target.name}. Nothing downloads until you confirm it.`}
            </Typography>
          </Stack>
          {servers && servers.length > 1 && (
            <ServerSwitcher servers={servers} value={serverId} onChange={chooseServer} />
          )}
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Close models"
            onClick={onClose}
            data-testid="models-close-btn"
          >
            <CloseIcon />
          </IconButton>
        </Stack>
      </Box>

      <Tabs
        value={tab}
        onChange={(_event, value) => choose(value === 'explore' ? 'explore' : 'installed')}
        sx={{ flex: 1, minHeight: 0, bgcolor: 'transparent' }}
      >
        <Box sx={{ py: 1 }}>
          <TabList
            variant="plain"
            sx={{
              ...screenColumnSx,
              gap: 0.5,
              bgcolor: 'transparent',
              '& .MuiTab-root': { borderRadius: 'md', minHeight: 34, px: 1.5 },
              '& .Mui-selected': { bgcolor: 'background.level1', boxShadow: 'sm' },
            }}
          >
            <Tab value="installed" data-testid="models-installed-tab">
              Installed{installedCount === null ? '' : ` (${installedCount})`}
            </Tab>
            <Tab value="explore" data-testid="models-explore-tab">
              Explore
            </Tab>
          </TabList>
        </Box>
        <Box sx={{ ...screenColumnSx, pb: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <RuntimeStatusBar status={status} target={target} onRetry={() => void hub.refresh()} />
          {note && (
            <Typography level="body-sm" textColor="text.tertiary" data-testid="models-manage-note">
              {note}
            </Typography>
          )}
          {hub.pulls.length > 0 && (
            <Stack spacing={1} data-testid="models-pull-list">
              {hub.pulls.map(pull => (
                <PullRow key={pull.key} pull={pull} />
              ))}
            </Stack>
          )}
        </Box>
        <TabPanel value="installed" sx={{ p: 0, flex: 1, ...scrollingColumnHostSx }}>
          <Box sx={{ ...screenColumnSx, py: 1 }}>
            <InstalledTab
              key={serverId}
              status={status}
              target={target}
              installed={status ? hub.installed : null}
              inUse={inUse}
              onRetry={() => void hub.refresh()}
              onExplore={() => choose('explore')}
            />
          </Box>
        </TabPanel>
        <TabPanel value="explore" sx={{ p: 0, flex: 1, ...scrollingColumnHostSx }}>
          <Box sx={{ ...screenColumnSx, py: 1 }}>
            <ExploreTab
              status={status}
              target={target}
              installed={status ? hub.installed : null}
              pulls={hub.pulls}
              onRecheck={() => void hub.refresh()}
            />
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
}
