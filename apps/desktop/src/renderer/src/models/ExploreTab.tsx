import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import Input from '@mui/joy/Input';
import LinearProgress from '@mui/joy/LinearProgress';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Typography from '@mui/joy/Typography';
import {
  formatBytes,
  formatCount,
  pullKey,
  type HubBuildView,
  type HubModelCard,
  type HubModelView,
  type InstalledModelsResult,
  type ModelHubError,
  type ModelPull,
  type ModelRuntimeStatus,
} from '@shared/models';
import { ExternalLink } from '../chat/ExternalLink';
import { SearchIcon } from '../chat/icons';
import { AccessSteps } from './AccessSteps';
import type { ModelTarget } from './modelTarget';
import { PullDialog, type PullConsent } from './PullDialog';
import { pullLabel, pullPercent } from './pullDisplay';

type SearchState =
  | { state: 'loading' }
  | { state: 'ready'; query: string; models: HubModelCard[]; nextCursor: string | null; loadingMore: boolean }
  | { state: 'error'; error: ModelHubError };

type DetailState =
  { state: 'loading' } | { state: 'ready'; model: HubModelView } | { state: 'error'; error: ModelHubError };

// Kept across visits so returning to the screen mid-pull shows the same search and repo.
const remembered = { query: '', selected: null as string | null, showAbliterated: false };

export function hubErrorText(error: ModelHubError): string {
  if (error.kind === 'rate-limited') {
    const seconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : null;
    return `Hugging Face is rate limiting this computer. Try again ${seconds ? `in ${seconds} seconds` : 'in a minute'}.`;
  }
  return error.message;
}

function ResultRow({ model, selected, onSelect }: { model: HubModelCard; selected: boolean; onSelect: () => void }) {
  return (
    <Sheet
      component="button"
      type="button"
      variant={selected ? 'soft' : 'outlined'}
      color={selected ? 'primary' : 'neutral'}
      onClick={onSelect}
      aria-pressed={selected}
      data-testid="models-explore-result-row"
      data-repo={model.id}
      sx={{
        borderRadius: 'md',
        px: 1.5,
        py: 1,
        textAlign: 'left',
        font: 'inherit',
        cursor: 'pointer',
        width: '100%',
      }}
    >
      <Typography level="body-sm" fontFamily="code" fontWeight="lg" noWrap>
        {model.id}
      </Typography>
      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
        <Typography level="body-xs" textColor="text.tertiary">
          {formatCount(model.downloads)} downloads
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {formatCount(model.likes)} likes
        </Typography>
        {model.licenses.map(license => (
          <Chip key={license} size="sm" variant="outlined" color="neutral" data-testid="models-explore-license-chip">
            {license}
          </Chip>
        ))}
        {model.gated && (
          <Chip size="sm" variant="soft" color="warning">
            Gated
          </Chip>
        )}
        {model.abliterated && (
          <Chip size="sm" variant="soft" color="danger" data-testid="models-explore-abliterated-chip">
            Abliterated
          </Chip>
        )}
      </Stack>
    </Sheet>
  );
}

function BuildRow({
  repo,
  build,
  pull,
  installed,
  runtimeReady,
  canPull,
  onPull,
}: {
  repo: string;
  build: HubBuildView;
  pull: ModelPull | undefined;
  installed: boolean;
  runtimeReady: boolean;
  canPull: boolean;
  onPull: () => void;
}) {
  let action = null;
  if (pull && pull.phase !== 'failed') {
    action = (
      <Stack spacing={0.5} sx={{ minWidth: 160 }} data-testid="models-build-progress">
        <LinearProgress
          determinate={pull.phase === 'downloading' || pull.phase === 'paused'}
          value={pullPercent(pull)}
          aria-label={`Download of ${repo} ${build.quant ?? build.id}`}
          aria-valuetext={pullLabel(pull)}
        />
        <Typography level="body-xs">{pullLabel(pull)}</Typography>
      </Stack>
    );
  } else if (installed) {
    action = (
      <Chip size="sm" color="success" variant="soft" data-testid="models-build-installed-chip">
        Installed
      </Chip>
    );
  } else if (build.blockedReason) {
    action = (
      <Typography
        level="body-xs"
        textColor="text.tertiary"
        sx={{ maxWidth: 240 }}
        data-testid="models-build-blocked-reason"
      >
        {build.blockedReason}
      </Typography>
    );
  } else if (canPull) {
    action = (
      <Button
        size="sm"
        variant="soft"
        disabled={!runtimeReady}
        onClick={onPull}
        data-testid="models-build-pull-btn"
        data-build={build.id}
      >
        Download
      </Button>
    );
  }
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{ py: 0.75, borderTop: '1px solid', borderColor: 'divider' }}
      data-testid="models-build-row"
      data-build={build.id}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography level="body-sm" fontFamily="code" noWrap>
          {build.quant ?? build.id}
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {formatBytes(build.sizeBytes)}
        </Typography>
      </Box>
      {action}
    </Stack>
  );
}

function ModelDetail({
  repo,
  status,
  target,
  installedNames,
  pulls,
  onRecheck,
}: {
  repo: string;
  status: ModelRuntimeStatus | null;
  target: ModelTarget;
  installedNames: Set<string>;
  pulls: ModelPull[];
  onRecheck: () => void;
}) {
  const [detail, setDetail] = useState<DetailState>({ state: 'loading' });
  const [confirmingOn, setConfirming] = useState<{ build: HubBuildView; serverId: string | undefined } | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setDetail({ state: 'loading' });
    const result = await window.b4m.models.getDetail(repo);
    setDetail(result.ok ? { state: 'ready', model: result.model } : { state: 'error', error: result.error });
  }, [repo]);

  useEffect(() => {
    setPullError(null);
    void load();
  }, [load]);

  if (detail.state === 'loading')
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }} data-testid="models-detail-loading">
        <CircularProgress size="sm" />
      </Box>
    );
  if (detail.state === 'error')
    return (
      <Alert
        color="danger"
        variant="soft"
        data-testid="models-detail-error"
        endDecorator={
          <Button size="sm" variant="plain" color="danger" onClick={() => void load()}>
            Retry
          </Button>
        }
      >
        {hubErrorText(detail.error)}
      </Alert>
    );

  const model = detail.model;
  const runtimeReady = status?.reachable === true;
  const canPull = target.management === 'allowed';
  const start = async (build: HubBuildView, serverId: string | undefined, consent: PullConsent) => {
    setConfirming(null);
    setPullError(null);
    const result = await window.b4m.models.pull({
      repo: model.id,
      buildId: build.id,
      revision: model.revision,
      sizeBytes: build.sizeBytes,
      ...consent,
      ...(serverId === undefined ? {} : { serverId }),
    });
    if (result.ok) return;
    if (result.error.kind === 'runtime-unavailable') onRecheck();
    if (result.listed || result.error.kind === 'cancelled') return;
    setPullError(hubErrorText(result.error));
    if (result.error.kind === 'changed') void load();
  };

  return (
    <Stack spacing={1.5} data-testid="models-detail" data-repo={model.id}>
      <Box>
        <Typography level="title-md" fontFamily="code" sx={{ wordBreak: 'break-all' }}>
          {model.id}
        </Typography>
        <ExternalLink href={model.url} testId="models-detail-repo-link">
          Open on Hugging Face
        </ExternalLink>
      </Box>
      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1} alignItems="center">
        <Typography level="body-xs" textColor="text.tertiary">
          {formatCount(model.downloads)} downloads
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {formatCount(model.likes)} likes
        </Typography>
        {model.abliterated && (
          <Chip size="sm" variant="soft" color="danger" data-testid="models-detail-abliterated-chip">
            Abliterated: refusal training removed
          </Chip>
        )}
      </Stack>

      <Box data-testid="models-detail-license" data-kind={model.licenseKind}>
        <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }}>
          License
        </Typography>
        <Stack direction="row" alignItems="center" flexWrap="wrap" useFlexGap spacing={1}>
          {(model.licenseNames.length ? model.licenseNames : ['Not declared']).map((name, index) => (
            <Chip
              key={`${index}-${name}`}
              size="sm"
              variant="soft"
              color={model.licenseKind === 'permissive' ? 'success' : 'warning'}
              data-testid="models-detail-license-chip"
            >
              {name}
            </Chip>
          ))}
          <ExternalLink href={model.licenseUrl} testId="models-detail-license-link">
            Read the license
          </ExternalLink>
          <Typography level="body-xs" textColor="text.tertiary" data-testid="models-detail-license-host">
            ({model.licenseHost})
          </Typography>
        </Stack>
        {model.licenseKind === 'restricted' && (
          <Typography level="body-xs" sx={{ mt: 0.5 }}>
            {model.licenseNames.length > 1
              ? 'Not all of these are standard permissive licenses. You will be asked to accept them before downloading.'
              : 'Not a standard permissive license. You will be asked to accept it before downloading.'}
          </Typography>
        )}
      </Box>

      {model.needsAccess && (
        <Alert color="warning" variant="soft" data-testid="models-detail-access">
          <Box>
            <AccessSteps model={model} server={target.local ? null : target.name} />
            <Typography level="body-xs" sx={{ mt: 0.75 }}>
              Bike4Mind cannot check gated files without a Hugging Face token, so their builds cannot be downloaded from
              here yet.
            </Typography>
          </Box>
        </Alert>
      )}
      {canPull && !runtimeReady && (
        <Alert color="neutral" variant="soft" data-testid="models-detail-runtime-down">
          {target.local
            ? 'Downloads need Ollama running on this computer.'
            : `Downloads need ${target.name} to be reachable.`}
        </Alert>
      )}
      {pullError && (
        <Alert color="danger" variant="soft" data-testid="models-detail-pull-error">
          {pullError}
        </Alert>
      )}

      <Box>
        <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 0.5 }}>
          Builds
        </Typography>
        {model.builds.length === 0 ? (
          <Typography level="body-sm">This repo has no GGUF files.</Typography>
        ) : (
          model.builds.map(build => (
            <BuildRow
              key={build.id}
              repo={model.id}
              build={build}
              pull={pulls.find(entry => entry.key === pullKey(model.id, build.id, target.id))}
              installed={!!build.ollamaRef && installedNames.has(build.ollamaRef.toLowerCase())}
              runtimeReady={runtimeReady}
              canPull={canPull}
              onPull={() => setConfirming({ build, serverId: target.local ? undefined : target.id })}
            />
          ))
        )}
        {model.projectorBytes !== null && (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.5 }}>
            Ollama adds a vision projector of up to {formatBytes(model.projectorBytes)} to each download.
          </Typography>
        )}
      </Box>

      {confirmingOn && (
        <PullDialog
          model={model}
          build={confirmingOn.build}
          target={target}
          onClose={() => setConfirming(null)}
          onConfirm={consent => void start(confirmingOn.build, confirmingOn.serverId, consent)}
        />
      )}
    </Stack>
  );
}

export function ExploreTab({
  status,
  target,
  installed,
  pulls,
  onRecheck,
}: {
  status: ModelRuntimeStatus | null;
  target: ModelTarget;
  installed: InstalledModelsResult | null;
  pulls: ModelPull[];
  onRecheck: () => void;
}) {
  const [query, setQuery] = useState(remembered.query);
  const [search, setSearch] = useState<SearchState>({ state: 'loading' });
  const [selected, setSelected] = useState<string | null>(remembered.selected);
  const [showAbliterated, setShowAbliterated] = useState(remembered.showAbliterated);
  const generation = useRef(0);

  const run = useCallback(async (text: string) => {
    const mine = ++generation.current;
    setSearch({ state: 'loading' });
    const result = await window.b4m.models.search({ query: text });
    if (mine !== generation.current) return;
    setSearch(
      result.ok
        ? { state: 'ready', query: text, models: result.models, nextCursor: result.nextCursor, loadingMore: false }
        : { state: 'error', error: result.error }
    );
  }, []);

  const more = async () => {
    if (search.state !== 'ready' || !search.nextCursor) return;
    const mine = generation.current;
    setSearch({ ...search, loadingMore: true });
    const result = await window.b4m.models.search({ query: search.query, cursor: search.nextCursor });
    if (mine !== generation.current) return;
    setSearch(
      result.ok
        ? { ...search, models: [...search.models, ...result.models], nextCursor: result.nextCursor, loadingMore: false }
        : { state: 'error', error: result.error }
    );
  };

  useEffect(() => {
    void run(remembered.query);
  }, [run]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    remembered.query = query.trim();
    void run(remembered.query);
  };
  const select = (repo: string) => {
    remembered.selected = repo;
    setSelected(repo);
  };
  const toggleAbliterated = (on: boolean) => {
    remembered.showAbliterated = on;
    setShowAbliterated(on);
  };

  const installedNames = useMemo(
    () => new Set(installed?.ok ? installed.models.map(model => model.name.toLowerCase()) : []),
    [installed]
  );
  const visible = search.state === 'ready' ? search.models.filter(model => showAbliterated || !model.abliterated) : [];
  const hidden = search.state === 'ready' ? search.models.length - visible.length : 0;

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 400px)' },
        alignItems: 'start',
      }}
    >
      <Stack spacing={1}>
        <form onSubmit={submit}>
          <Stack direction="row" spacing={1}>
            <Input
              size="sm"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search GGUF models on Hugging Face"
              startDecorator={<SearchIcon />}
              slotProps={{
                input: { 'data-testid': 'models-explore-search-input', 'aria-label': 'Search Hugging Face' },
              }}
              sx={{ flex: 1, minWidth: 0 }}
            />
            <Button size="sm" type="submit" variant="outlined" color="neutral" data-testid="models-explore-search-btn">
              Search
            </Button>
          </Stack>
        </form>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography level="body-xs" textColor="text.tertiary" sx={{ flex: 1 }}>
            Searches Hugging Face from this computer. Only GGUF repos are listed.
            {!target.local &&
              target.management === 'allowed' &&
              ` Downloads go to ${target.name}, which fetches them from Hugging Face itself.`}
          </Typography>
          <Typography component="label" level="body-xs" sx={{ display: 'flex', gap: 1 }}>
            Show abliterated models
            <Switch
              size="sm"
              checked={showAbliterated}
              onChange={event => toggleAbliterated(event.target.checked)}
              slotProps={{ input: { 'data-testid': 'models-explore-abliterated-switch' } }}
            />
          </Typography>
        </Stack>

        {search.state === 'loading' && (
          <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }} data-testid="models-explore-loading">
            <CircularProgress size="sm" />
          </Box>
        )}
        {search.state === 'error' && (
          <Alert
            color={search.error.kind === 'rate-limited' ? 'warning' : 'danger'}
            variant="soft"
            data-testid="models-explore-error"
            data-kind={search.error.kind}
            endDecorator={
              <Button size="sm" variant="plain" color="neutral" onClick={() => void run(remembered.query)}>
                Retry
              </Button>
            }
          >
            {hubErrorText(search.error)}
          </Alert>
        )}
        {search.state === 'ready' && search.models.length === 0 && (
          <Typography level="body-sm" sx={{ py: 4, textAlign: 'center' }} data-testid="models-explore-empty">
            {search.query ? `No GGUF models match "${search.query}".` : 'No GGUF models found.'}
          </Typography>
        )}
        {visible.map(model => (
          <ResultRow key={model.id} model={model} selected={model.id === selected} onSelect={() => select(model.id)} />
        ))}
        {hidden > 0 && (
          <Typography level="body-xs" textColor="text.tertiary" data-testid="models-explore-hidden-note">
            {hidden} abliterated {hidden === 1 ? 'result is' : 'results are'} hidden.
          </Typography>
        )}
        {search.state === 'ready' && search.nextCursor && (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            loading={search.loadingMore}
            onClick={() => void more()}
            data-testid="models-explore-more-btn"
          >
            Load more
          </Button>
        )}
      </Stack>

      <Sheet variant="outlined" sx={{ borderRadius: 'md', p: 2, position: { md: 'sticky' }, top: { md: 8 } }}>
        {selected ? (
          <ModelDetail
            key={`${target.id}:${selected}`}
            repo={selected}
            status={status}
            target={target}
            installedNames={installedNames}
            pulls={pulls}
            onRecheck={onRecheck}
          />
        ) : (
          <Box data-testid="models-detail-empty">
            <Typography level="title-sm">Pick a result</Typography>
            <Typography level="body-sm" textColor="text.tertiary" sx={{ mt: 0.5 }}>
              See its builds, sizes and license before anything downloads.
            </Typography>
          </Box>
        )}
      </Sheet>
    </Box>
  );
}
