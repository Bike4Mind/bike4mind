import { useState } from 'react';
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
import { OLLAMA_DOWNLOAD_URL, type ModelPull, type ModelRuntimeStatus } from '@shared/models';
import { ExternalLink } from '../chat/ExternalLink';
import { CloseIcon } from '../chat/icons';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from '../chat/layout';
import { CuratedTab } from './CuratedTab';
import { ExploreTab, rememberExploreRepo } from './ExploreTab';
import { InstalledTab, type ModelsInUse } from './InstalledTab';
import { pullLabel, pullPercent } from './pullDisplay';
import { useModelHub } from './useModelHub';

type ModelsTab = 'curated' | 'installed' | 'explore';
const TABS: readonly ModelsTab[] = ['curated', 'installed', 'explore'];

const screenColumnSx = { ...contentColumnSx, maxWidth: 1120 };

// Survives leaving the screen, so coming back mid-pull lands where the user was.
let rememberedTab: ModelsTab = 'curated';

function RuntimeStatusBar({ status, onRetry }: { status: ModelRuntimeStatus | null; onRetry: () => void }) {
  if (!status)
    return (
      <Typography level="body-sm" textColor="text.tertiary" data-testid="models-runtime-status" data-state="checking">
        Checking for Ollama...
      </Typography>
    );
  if (status.reachable)
    return (
      <Stack direction="row" alignItems="center" spacing={1} data-testid="models-runtime-status" data-state="running">
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.500', flexShrink: 0 }} />
        <Typography level="body-sm">
          Ollama {status.version ?? ''} running at{' '}
          <Typography fontFamily="code">{status.url.replace(/^https?:\/\//, '')}</Typography>
        </Typography>
      </Stack>
    );
  return (
    <Stack direction="row" alignItems="center" spacing={1} data-testid="models-runtime-status" data-state="down">
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'danger.500', flexShrink: 0 }} />
      <Typography level="body-sm" sx={{ flex: 1 }}>
        Ollama is not running on this computer. Start it, or install it from{' '}
        <ExternalLink href={OLLAMA_DOWNLOAD_URL} testId="models-runtime-download-link">
          ollama.com/download
        </ExternalLink>
        .
      </Typography>
      <Button size="sm" variant="outlined" color="neutral" onClick={onRetry} data-testid="models-runtime-retry-btn">
        Check again
      </Button>
    </Stack>
  );
}

function PullRow({ pull }: { pull: ModelPull }) {
  const failed = pull.phase === 'failed';
  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'md', px: 1.5, py: 1 }}
      data-testid="models-pull-row"
      data-key={pull.key}
      data-phase={pull.phase}
    >
      <Stack direction="row" alignItems="center" spacing={1}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" fontFamily="code" noWrap>
            {pull.repo} {pull.label ?? ''}
          </Typography>
          <Typography
            level="body-xs"
            color={failed ? 'danger' : 'neutral'}
            data-testid="models-pull-status"
            sx={{ mt: 0.25 }}
          >
            {pullLabel(pull)}
          </Typography>
        </Box>
        {failed ? (
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
          determinate={pull.phase === 'downloading'}
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

/** Local models: a curated list, what is installed, and GGUF builds from Hugging Face to download through Ollama. */
export function ModelsScreen({ onClose, inUse }: { onClose: () => void; inUse?: ModelsInUse }) {
  const hub = useModelHub();
  const [tab, setTab] = useState<ModelsTab>(rememberedTab);
  const choose = (next: ModelsTab) => {
    rememberedTab = next;
    setTab(next);
  };
  const installedCount = hub.installed?.ok ? hub.installed.models.length : null;

  return (
    <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }} data-testid="models-screen">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...screenColumnSx, py: 1.25 }}>
          <Stack sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="title-sm" component="h1">
              Models
            </Typography>
            <Typography level="body-xs" textColor="text.tertiary">
              Run open models on this computer with Ollama. Nothing downloads until you confirm it.
            </Typography>
          </Stack>
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
          <RuntimeStatusBar status={hub.status} onRetry={() => void hub.refresh()} />
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
              status={hub.status}
              installed={hub.installed}
              pulls={hub.pulls}
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
              status={hub.status}
              installed={hub.installed}
              inUse={inUse}
              onRetry={() => void hub.refresh()}
              onExplore={() => choose('explore')}
            />
          </Box>
        </TabPanel>
        <TabPanel value="explore" sx={{ p: 0, flex: 1, ...scrollingColumnHostSx }}>
          <Box sx={{ ...screenColumnSx, py: 1 }}>
            <ExploreTab
              status={hub.status}
              installed={hub.installed}
              pulls={hub.pulls}
              onRecheck={() => void hub.refresh()}
            />
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
}
