import { useEffect, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
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
import type { ChatModelOption } from '@shared/chat';
import { LOCAL_SERVER_ID, LOCAL_SERVER_NAME, serverManagement, type ModelServerView } from '@shared/modelServers';
import { OLLAMA_DOWNLOAD_URL, type ModelPull, type ModelRuntimeStatus } from '@shared/models';
import { CloseIcon, ReloadIcon } from '../chat/icons';
import { isWindows } from '../chat/platform';
import { FOCUS_RELOAD_MIN_MS } from '../chat/useChat';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from '../chat/layout';
import { missingFromCatalog } from './catalogSync';
import { CuratedTab } from './CuratedTab';
import { ExploreTab, rememberExploreRepo } from './ExploreTab';
import { serverIdentity } from './installedCache';
import { InstalledTab, type ModelsInUse } from './InstalledTab';
import { manageNote, type ChatWith, type ModelTarget, type ModelWith } from './modelTarget';
import { pullLabel, pullPercent } from './pullDisplay';
import { ServerSwitcher } from './ServerSwitcher';
import { useModelHub, useModelServers } from './useModelHub';

type ModelsTab = 'curated' | 'installed' | 'explore';
const TABS: readonly ModelsTab[] = ['curated', 'installed', 'explore'];

const screenColumnSx = { ...contentColumnSx, maxWidth: 1120 };

// Survive leaving the screen, so coming back mid-pull lands where the user was.
let rememberedTab: ModelsTab = 'curated';
let rememberedServer = LOCAL_SERVER_ID;

const dot = (color: string) => <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />;

/** No Ollama answers on this computer: the two ways forward, neither of which installs anything by itself. */
function NoLocalRuntime({
  status,
  address,
  onRetry,
  onOpenModelServers,
}: {
  status: ModelRuntimeStatus;
  address: ReactNode;
  onRetry: () => void;
  onOpenModelServers?: () => void;
}) {
  return (
    <Sheet
      variant="soft"
      sx={{ borderRadius: 'md', px: 1.5, py: 1.25 }}
      data-testid="models-runtime-status"
      data-state="down"
    >
      <Stack direction="row" alignItems="center" spacing={1}>
        {dot('danger.500')}
        <Typography level="title-sm">Ollama did not answer on this computer</Typography>
      </Stack>
      <Typography level="body-sm" sx={{ mt: 0.5 }} data-testid="models-no-runtime-text">
        Local models run in Ollama, and Desktop got no answer from {address}. If it is not installed, install it; if it
        is, start it or give it a moment. This checks again every few seconds. To use models on another machine instead,
        point Desktop at its server.
      </Typography>
      {isWindows && onOpenModelServers && (
        <Typography level="body-sm" sx={{ mt: 0.5 }} data-testid="models-no-runtime-wsl-hint">
          If Ollama runs in WSL, start it there. Desktop looks for it at {address} on Windows, which works only when WSL
          shares that address with Windows. If it does not, add it with Point at a server.
        </Typography>
      )}
      {status.error && (
        <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }} data-testid="models-no-runtime-error">
          {status.error}
        </Typography>
      )}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
        <Button
          size="sm"
          onClick={() => void window.b4m.shell.openExternal(OLLAMA_DOWNLOAD_URL)}
          data-testid="models-install-ollama-btn"
        >
          Install Ollama
        </Button>
        {onOpenModelServers && (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={onOpenModelServers}
            data-testid="models-point-at-server-btn"
          >
            Point at a server
          </Button>
        )}
        <Button size="sm" variant="plain" color="neutral" onClick={onRetry} data-testid="models-runtime-retry-btn">
          Check again
        </Button>
      </Stack>
    </Sheet>
  );
}

function RuntimeStatusBar({
  status,
  target,
  onRetry,
  onOpenModelServers,
}: {
  status: ModelRuntimeStatus | null;
  target: ModelTarget;
  onRetry: () => void;
  onOpenModelServers?: () => void;
}) {
  if (!status)
    return (
      <Typography level="body-sm" textColor="text.tertiary" data-testid="models-runtime-status" data-state="checking">
        {target.local ? 'Checking for Ollama...' : `Checking ${target.name}...`}
      </Typography>
    );
  const ssh = status.url.startsWith('ssh://');
  const address = (
    <>
      <Typography fontFamily="code">{status.url.replace(/^(https?|ssh):\/\//, '')}</Typography>
      {ssh && ' over SSH'}
    </>
  );
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
  if (target.local)
    return (
      <NoLocalRuntime status={status} address={address} onRetry={onRetry} onOpenModelServers={onOpenModelServers} />
    );
  return (
    <Stack direction="row" alignItems="center" spacing={1} data-testid="models-runtime-status" data-state="down">
      {dot('danger.500')}
      <Typography level="body-sm" sx={{ flex: 1 }}>
        {status.error ?? `Could not reach ${target.name}.`}
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
            {pull.repo} {pull.label ?? ''}
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
          aria-label={`Download of ${pull.repo} ${pull.label ?? pull.buildId}`}
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

/** Open models on this computer or a saved server: a curated list, what is installed, and GGUF builds to download. */
export function ModelsScreen({
  onClose,
  inUse,
  onOpenModelServers,
  chatWith,
  modelWith,
  catalog,
  chatError,
  onDismissChatError,
}: {
  onClose: () => void;
  inUse?: ModelsInUse;
  /** Settings, Model servers: where a server on another machine is added. */
  onOpenModelServers?: () => void;
  chatWith?: ChatWith;
  /** Chat's entry for an installed model, for its Settings dialog. */
  modelWith?: ModelWith;
  /** The chat model catalog Use in chat resolves against; reloaded when the installed list outgrows it. */
  catalog?: { models: ChatModelOption[]; loading: boolean; reload: () => Promise<void> };
  /** Why the last Use in chat did not open a conversation. */
  chatError?: string | null;
  onDismissChatError?: () => void;
}) {
  const servers = useModelServers();
  const [chosenServer, setChosenServer] = useState(rememberedServer);
  // A server removed in Settings falls back to this computer.
  const serverId = servers && !servers.some(server => server.id === chosenServer) ? LOCAL_SERVER_ID : chosenServer;
  const shownServer = servers?.find(server => server.id === serverId);
  const hub = useModelHub(serverId, shownServer ? serverIdentity(shownServer) : null);
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
  const installedCount =
    status && hub.installed?.ok ? hub.installed.models.length : (hub.lastInstalled?.models.length ?? null);
  const note = manageNote(target);
  const chatOn = (name: string) => chatWith?.(serverId, name) ?? null;

  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await Promise.all([hub.refresh(), catalog?.reload()]);
    } catch {
      // The next refresh retries; a rejected status read must not escape the click handler.
    } finally {
      setRefreshing(false);
    }
  };

  const catalogModels = catalog?.models;
  const catalogLoading = catalog?.loading ?? true;
  const reloadCatalog = catalog?.reload;
  const installedModels = status && hub.installed?.ok ? hub.installed.models : null;
  const serverKind = servers?.find(server => server.id === serverId)?.kind ?? 'ollama';
  const mismatchKey =
    installedModels && catalogModels && !catalogLoading
      ? missingFromCatalog(installedModels, serverId, catalogModels, serverKind).join('\n')
      : null;
  const reloadedFor = useRef(new Set<string>());
  useEffect(() => {
    // One reload per distinct mismatch per server: a model the server never lists must not loop.
    if (mismatchKey === null) return;
    const prefix = `${serverId}\n`;
    if (mismatchKey === '') {
      for (const key of reloadedFor.current) if (key.startsWith(prefix)) reloadedFor.current.delete(key);
      return;
    }
    const key = prefix + mismatchKey;
    if (reloadedFor.current.has(key)) return;
    reloadedFor.current.add(key);
    void reloadCatalog?.();
  }, [serverId, mismatchKey, reloadCatalog]);

  const lastFocusRefresh = useRef(Date.now());
  useEffect(() => {
    const onFocus = () => {
      if (document.hidden || Date.now() - lastFocusRefresh.current < FOCUS_RELOAD_MIN_MS) return;
      lastFocusRefresh.current = Date.now();
      refresh().catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

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
            aria-label="Refresh models"
            title="Refresh models"
            loading={refreshing}
            onClick={() => void refreshAll()}
            data-testid="models-refresh-btn"
          >
            <ReloadIcon />
          </IconButton>
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
        onChange={(_event, value) => choose(TABS.find(candidate => candidate === value) ?? 'curated')}
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
            <Tab value="curated" data-testid="models-curated-tab">
              Curated
            </Tab>
            <Tab value="installed" data-testid="models-installed-tab">
              Installed{installedCount === null ? '' : ` (${installedCount})`}
            </Tab>
            <Tab value="explore" data-testid="models-explore-tab">
              Explore
            </Tab>
          </TabList>
        </Box>
        <Box sx={{ ...screenColumnSx, pb: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <RuntimeStatusBar
            status={status}
            target={target}
            onRetry={() => void hub.refresh()}
            onOpenModelServers={onOpenModelServers}
          />
          {note && (
            <Typography level="body-sm" textColor="text.tertiary" data-testid="models-manage-note">
              {note}
            </Typography>
          )}
          {chatError && (
            <Alert
              color="danger"
              variant="soft"
              data-testid="models-chat-error"
              endDecorator={
                onDismissChatError && (
                  <Button
                    size="sm"
                    variant="plain"
                    color="danger"
                    onClick={onDismissChatError}
                    data-testid="models-chat-error-dismiss-btn"
                  >
                    Dismiss
                  </Button>
                )
              }
            >
              {chatError}
            </Alert>
          )}
          {hub.pulls.length > 0 && (
            <Stack spacing={1} data-testid="models-pull-list">
              {hub.pulls.map(pull => (
                <PullRow key={pull.key} pull={pull} />
              ))}
            </Stack>
          )}
        </Box>
        <TabPanel value="curated" sx={{ p: 0, flex: 1, ...scrollingColumnHostSx }}>
          <Box sx={{ ...screenColumnSx, py: 1 }}>
            <CuratedTab
              key={serverId}
              status={status}
              target={target}
              installed={status ? hub.installed : null}
              pulls={hub.pulls}
              chatOn={chatOn}
              onRecheck={() => void hub.refresh()}
              onOpenInExplore={repo => {
                rememberExploreRepo(repo);
                choose('explore');
              }}
            />
          </Box>
        </TabPanel>
        <TabPanel value="installed" sx={{ p: 0, flex: 1, ...scrollingColumnHostSx }}>
          <Box sx={{ ...screenColumnSx, py: 1 }}>
            <InstalledTab
              key={serverId}
              status={status}
              target={target}
              installed={status ? hub.installed : null}
              lastInstalled={hub.lastInstalled}
              inUse={inUse}
              chatOn={chatOn}
              modelOn={name => modelWith?.(serverId, name) ?? null}
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
              chatOn={chatOn}
              onRecheck={() => void hub.refresh()}
            />
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
}
