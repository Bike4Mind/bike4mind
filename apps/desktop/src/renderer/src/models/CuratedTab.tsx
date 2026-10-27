import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import {
  formatMemory,
  pullKey,
  type CuratedBuildView,
  type CuratedEntryView,
  type CuratedList,
  type CuratedPickView,
  type CuratedSlot,
  type HubBuildView,
  type HubModelView,
  type InstalledModelsResult,
  type MachineView,
  type ModelHubError,
  type ModelPull,
  type ModelRuntimeStatus,
} from '@shared/models';
import { ExternalLink } from '../chat/ExternalLink';
import { BuildRow, hubErrorText, startPull } from './ExploreTab';
import { PullDialog, type PullConsent } from './PullDialog';

const SLOT_LABELS: Record<CuratedSlot, string> = {
  best: 'Best',
  fast: 'Fast',
  'long-context': 'Long context',
  light: 'Light',
};
const RATING_TEXT = { weak: 'weak', ok: 'good', strong: 'strong' } as const;
const CHECK_FAILED = 'Could not check this model with the Models service. Try again.';

function machineText(machine: MachineView): string {
  const memory = formatMemory(machine.totalMemoryBytes);
  if (machine.memoryKind === 'unified') return `This computer has ${memory} of memory, shared with its GPU.`;
  if (machine.memoryKind === 'discrete' && machine.gpuMemoryBytes)
    return `This computer has ${memory} of RAM and ${formatMemory(machine.gpuMemoryBytes)} of GPU memory${
      machine.gpuName ? ` (${machine.gpuName})` : ''
    }.`;
  return `This computer has ${memory} of RAM and no GPU memory was detected, so badges assume models run on the CPU.`;
}

function listDate(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return updatedAt;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function ToolsChip({ entry }: { entry: CuratedEntryView }) {
  const { rating, note } = entry.toolUse;
  if (!entry.tools)
    return (
      <Tooltip title="Its chat template has no tool calls, so chat sends it none." size="sm" describeChild>
        <Chip size="sm" variant="outlined" color="neutral" tabIndex={0} data-testid="models-curated-tools-chip">
          No tools
        </Chip>
      </Tooltip>
    );
  const label = rating === 'unrated' ? 'Tools' : `Tools: ${RATING_TEXT[rating]}`;
  const title =
    rating === 'unrated'
      ? 'Supports tool calls, and chat sends it tools. Bike4Mind has not rated how well it uses them yet.'
      : `Supports tool calls, and chat sends it tools. Bike4Mind's tests rate its tool use ${RATING_TEXT[rating]}.${
          note ? ` ${note}` : ''
        }`;
  return (
    <Tooltip title={title} size="sm" sx={{ maxWidth: 320 }} describeChild>
      <Chip
        size="sm"
        variant="outlined"
        color="neutral"
        tabIndex={0}
        data-testid="models-curated-tools-chip"
        data-rating={rating}
      >
        {label}
      </Chip>
    </Tooltip>
  );
}

function LicenseChip({ entry }: { entry: CuratedEntryView }) {
  const restricted = entry.licenseKind === 'restricted';
  return (
    <Chip
      size="sm"
      variant="soft"
      color={restricted ? 'warning' : 'success'}
      data-testid="models-curated-license-chip"
      data-kind={entry.licenseKind}
    >
      {restricted ? `Restricted license: ${entry.licenseName}` : entry.licenseName}
    </Chip>
  );
}

function VisionChip({ entry }: { entry: CuratedEntryView }) {
  if (!entry.vision) return null;
  return (
    <Chip size="sm" variant="outlined" color="neutral" data-testid="models-curated-vision-chip">
      Vision
    </Chip>
  );
}

// Lets the shared row show a curated build; the dialog and the pull use what main hands back for it.
function rowBuild(build: CuratedBuildView): HubBuildView {
  return {
    id: build.pullBuildId,
    quant: build.quant,
    sizeBytes: build.sizeBytes,
    ollamaRef: build.ollamaRef,
    blockedReason: build.blockedReason,
    fit: build.fit,
  };
}

interface Confirming {
  model: HubModelView;
  build: HubBuildView;
  curated: { entryId: string; buildId: string };
  where: string;
}

interface RowError {
  where: string;
  text: string;
  /** Set when Explore can show the Hugging Face repo as it is now. */
  repo: string | null;
}

/** The Download flow shared by the picks and the full list: check with main, confirm, then pull. */
function useCuratedPull(onRecheck: () => void) {
  const [preparing, setPreparing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [error, setError] = useState<RowError | null>(null);
  // Only the latest Download click may open the dialog; an earlier, slower check is dropped.
  const latest = useRef(0);

  const showError = (where: string, failure: ModelHubError, build: CuratedBuildView) =>
    setError({
      where,
      text: hubErrorText(failure),
      repo: failure.kind === 'upstream-changed' && build.ollamaRef.startsWith('hf.co/') ? build.repo : null,
    });

  const review = async (where: string, entry: CuratedEntryView, build: CuratedBuildView) => {
    const request = ++latest.current;
    setError(null);
    setPreparing(where);
    try {
      const result = await window.b4m.models.getCuratedPull(entry.id, build.id);
      if (request !== latest.current) return;
      if (result.ok)
        setConfirming({
          model: result.model,
          build: result.build,
          curated: { entryId: entry.id, buildId: build.id },
          where,
        });
      else showError(where, result.error, build);
    } catch {
      if (request === latest.current) setError({ where, text: CHECK_FAILED, repo: null });
    } finally {
      if (request === latest.current) setPreparing(null);
    }
  };

  const confirm = async (pending: Confirming, consent: PullConsent, build: CuratedBuildView) => {
    setConfirming(null);
    try {
      const failure = await startPull(pending.model, pending.build, consent, onRecheck, pending.curated);
      if (failure) showError(pending.where, failure, build);
    } catch {
      setError({ where: pending.where, text: CHECK_FAILED, repo: null });
    }
  };

  return { preparing, confirming, error, review, confirm, cancel: () => setConfirming(null) };
}

type CuratedPull = ReturnType<typeof useCuratedPull>;

interface RowContext {
  flow: CuratedPull;
  installedNames: Set<string>;
  pulls: ModelPull[];
  runtimeReady: boolean;
  onOpenInExplore: (repo: string) => void;
}

function CuratedBuild({
  where,
  entry,
  build,
  context,
}: {
  where: string;
  entry: CuratedEntryView;
  build: CuratedBuildView;
  context: RowContext;
}) {
  const { flow, installedNames, pulls, runtimeReady, onOpenInExplore } = context;
  const error = flow.error?.where === where ? flow.error : null;
  const confirming = flow.confirming?.where === where ? flow.confirming : null;
  return (
    <>
      <BuildRow
        repo={build.repo}
        build={rowBuild(build)}
        pull={pulls.find(pull => pull.key === pullKey(build.repo, build.pullBuildId))}
        installed={installedNames.has(build.ollamaRef.toLowerCase())}
        runtimeReady={runtimeReady}
        preparing={flow.preparing === where}
        onPull={() => void flow.review(where, entry, build)}
      />
      {error && (
        <Alert
          color="danger"
          variant="soft"
          sx={{ my: 0.5 }}
          data-testid="models-curated-error"
          endDecorator={
            error.repo && (
              <Button
                size="sm"
                variant="outlined"
                color="danger"
                onClick={() => error.repo && onOpenInExplore(error.repo)}
                data-testid="models-curated-explore-btn"
              >
                Open in Explore
              </Button>
            )
          }
        >
          {error.text}
        </Alert>
      )}
      {confirming && (
        <PullDialog
          key={where}
          model={confirming.model}
          build={confirming.build}
          onClose={flow.cancel}
          onConfirm={consent => void flow.confirm(confirming, consent, build)}
        />
      )}
    </>
  );
}

function PickRow({
  pick,
  entry,
  build,
  context,
}: {
  pick: CuratedPickView;
  entry: CuratedEntryView;
  build: CuratedBuildView;
  context: RowContext;
}) {
  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'md', px: 1.5, pt: 1, pb: 0.25 }}
      data-testid="models-curated-pick"
      data-slot={pick.slot}
      data-entry={entry.id}
      data-build={build.id}
    >
      <Stack direction="row" alignItems="center" flexWrap="wrap" useFlexGap spacing={1} sx={{ pb: 0.75 }}>
        <Chip size="sm" variant="solid" color="neutral" data-testid="models-curated-slot-chip">
          {SLOT_LABELS[pick.slot]}
        </Chip>
        {pick.recommended && (
          <Chip size="sm" variant="solid" color="primary" data-testid="models-curated-recommended-chip">
            Recommended
          </Chip>
        )}
        <Typography level="title-sm">{entry.name}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {entry.params}
        </Typography>
        <VisionChip entry={entry} />
      </Stack>
      <CuratedBuild where={`pick:${pick.slot}`} entry={entry} build={build} context={context} />
    </Sheet>
  );
}

function EntryCard({ entry, context }: { entry: CuratedEntryView; context: RowContext }) {
  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'md', px: 1.5, py: 1.25 }}
      data-testid="models-curated-entry"
      data-entry={entry.id}
    >
      <Stack direction="row" alignItems="baseline" flexWrap="wrap" useFlexGap spacing={1}>
        <Typography level="title-sm">{entry.name}</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          {entry.params}
        </Typography>
        <LicenseChip entry={entry} />
        <VisionChip entry={entry} />
        {entry.thinking && (
          <Chip size="sm" variant="outlined" color="neutral">
            Thinking
          </Chip>
        )}
        {entry.code && (
          <Chip size="sm" variant="outlined" color="neutral">
            Code
          </Chip>
        )}
        <ToolsChip entry={entry} />
      </Stack>
      <Typography level="body-sm" sx={{ mt: 0.5 }} data-testid="models-curated-why">
        {entry.why}
      </Typography>
      <Stack direction="row" spacing={1.5} sx={{ mt: 0.5 }}>
        <ExternalLink href={entry.sourceUrl} testId="models-curated-source-link">
          {entry.sourceName}
        </ExternalLink>
        <ExternalLink href={entry.licenseUrl} testId="models-curated-license-link">
          License
        </ExternalLink>
      </Stack>
      <Box sx={{ mt: 1 }}>
        {entry.builds.map(build => (
          <CuratedBuild
            key={build.id}
            where={`entry:${entry.id}:${build.id}`}
            entry={entry}
            build={build}
            context={context}
          />
        ))}
      </Box>
      {entry.builds.length > 1 && (
        <Typography level="body-xs" textColor="text.tertiary" data-testid="models-curated-quant-hint">
          Smaller quants download faster and use less memory; larger ones stay closer to the full model&apos;s quality.
        </Typography>
      )}
    </Sheet>
  );
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  return (
    <Stack spacing={1} data-testid={testId}>
      <Typography level="title-sm" sx={{ pt: 1 }}>
        {title}
      </Typography>
      {children}
    </Stack>
  );
}

/** Open models Bike4Mind picked: this computer's picks first, then every model on the list with its fit. */
export function CuratedTab({
  status,
  installed,
  pulls,
  onRecheck,
  onOpenInExplore,
}: {
  status: ModelRuntimeStatus | null;
  installed: InstalledModelsResult | null;
  pulls: ModelPull[];
  onRecheck: () => void;
  onOpenInExplore: (repo: string) => void;
}) {
  const [list, setList] = useState<CuratedList | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const flow = useCuratedPull(onRecheck);

  useEffect(() => {
    let live = true;
    setLoadFailed(false);
    window.b4m.models.listCurated().then(
      next => live && setList(next),
      () => live && setLoadFailed(true)
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  const installedNames = useMemo(
    () => new Set(installed?.ok ? installed.models.map(model => model.name.toLowerCase()) : []),
    [installed]
  );

  if (!list && loadFailed)
    return (
      <Alert
        color="danger"
        variant="soft"
        data-testid="models-curated-load-error"
        endDecorator={
          <Button
            size="sm"
            variant="outlined"
            color="danger"
            onClick={() => setAttempt(n => n + 1)}
            data-testid="models-curated-retry-btn"
          >
            Try again
          </Button>
        }
      >
        Could not load the curated list.
      </Alert>
    );

  if (!list)
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }} data-testid="models-curated-loading">
        <CircularProgress size="sm" />
      </Box>
    );

  const runtimeReady = status?.reachable === true;
  const context: RowContext = { flow, installedNames, pulls, runtimeReady, onOpenInExplore };
  const picks = list.picks.flatMap(pick => {
    const entry = list.entries.find(candidate => candidate.id === pick.entryId);
    const build = entry?.builds.find(candidate => candidate.id === pick.buildId);
    return entry && build ? [{ pick, entry, build }] : [];
  });

  return (
    <Stack spacing={1} data-testid="models-curated">
      <Typography level="body-xs" textColor="text.tertiary" data-testid="models-curated-machine">
        <span data-testid="models-curated-date">Curated list from {listDate(list.updatedAt)}.</span>{' '}
        {machineText(list.machine)} Hover a badge for why.
      </Typography>
      {!runtimeReady && (
        <Alert color="neutral" variant="soft" data-testid="models-curated-runtime-down">
          Downloads need Ollama running on this computer.
        </Alert>
      )}
      <Section title="For this computer" testId="models-curated-picks">
        {picks.length === 0 ? (
          <Typography level="body-sm" textColor="text.tertiary" data-testid="models-curated-no-picks">
            The list has no picks for this computer&apos;s memory yet. Every model below shows whether it fits.
          </Typography>
        ) : (
          picks.map(({ pick, entry, build }) => (
            <PickRow key={pick.slot} pick={pick} entry={entry} build={build} context={context} />
          ))
        )}
      </Section>
      <Section title="All curated models, smallest first" testId="models-curated-all">
        {list.entries.map(entry => (
          <EntryCard key={entry.id} entry={entry} context={context} />
        ))}
      </Section>
    </Stack>
  );
}
