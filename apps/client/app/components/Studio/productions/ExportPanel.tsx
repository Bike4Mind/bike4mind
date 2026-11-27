import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  DialogTitle,
  Divider,
  LinearProgress,
  Link,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import {
  DEFAULT_STUDIO_RENDER_PRICING,
  StudioRenderPricingSchema,
  estimateStudioRenderUsd,
  usdToCredits,
  type StudioRenderJob,
  type StudioTimeline,
} from '@bike4mind/common';
import { fabFileKeys } from '@client/app/hooks/data/fabFileKeys';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import {
  isRenderInFlight,
  renderErrorMessage,
  useCreateStudioRenders,
  useStudioRenders,
} from '@client/app/hooks/data/studioRenders';
import { getFabFileByIdFromServer } from '@client/app/utils/filesAPICalls';

type ExportPanelProps = {
  compositionId: string;
  timeline: StudioTimeline;
  /** True once the editor's autosave has stored exactly what is on screen; the server renders the stored timeline. */
  canExport: boolean;
};

const STATE_LABEL: Record<StudioRenderJob['state'], string> = {
  pending: 'Queued',
  running: 'Rendering',
  storing: 'Saving',
  succeeded: 'Ready',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

const STATE_COLOR: Record<StudioRenderJob['state'], 'neutral' | 'primary' | 'success' | 'danger' | 'warning'> = {
  pending: 'neutral',
  running: 'primary',
  storing: 'primary',
  succeeded: 'success',
  failed: 'danger',
  blocked: 'warning',
  cancelled: 'neutral',
};

const hasClips = (timeline: StudioTimeline): boolean =>
  timeline.tracks.some(track => track.enabled && track.clips.length > 0);

const useRenderPricing = () => {
  const setting = useGetSettingsValue('StudioRenderPricing');
  return useMemo(() => {
    const parsed = StudioRenderPricingSchema.safeParse(setting);
    return parsed.success ? parsed.data : DEFAULT_STUDIO_RENDER_PRICING;
  }, [setting]);
};

const groupByGroupId = (jobs: StudioRenderJob[]): StudioRenderJob[][] => {
  const groups = new Map<string, StudioRenderJob[]>();
  for (const job of jobs) groups.set(job.groupId, [...(groups.get(job.groupId) ?? []), job]);
  return [...groups.values()];
};

const DOWNLOAD_URL_RETRY_MS = 3000;

type DownloadableFile = { presignedUrl?: string | null; fileUrl?: string | null };

const downloadUrlOf = (file: DownloadableFile | undefined) => file?.presignedUrl ?? file?.fileUrl;

const DownloadLink = ({ job }: { job: StudioRenderJob }) => {
  const fileId = job.file?.fileId ?? null;
  const { data: file } = useQuery({
    queryKey: fabFileKeys.doc(fileId ?? ''),
    queryFn: () => getFabFileByIdFromServer(fileId ?? ''),
    enabled: fileId !== null,
    // The job can turn succeeded a moment before its file serves a URL; keep asking until it does.
    refetchInterval: query => (downloadUrlOf(query.state.data) ? false : DOWNLOAD_URL_RETRY_MS),
  });
  const url = downloadUrlOf(file);
  if (!url) return null;
  return (
    <Link
      href={url}
      download={file?.fileName}
      target="_blank"
      rel="noopener noreferrer"
      level="body-sm"
      data-testid={`production-export-download-link-${job.id}`}
    >
      Download
    </Link>
  );
};

const JobRow = ({ job }: { job: StudioRenderJob }) => (
  <Stack spacing={0.5} data-testid={`production-export-job-row-${job.id}`}>
    <Stack direction="row" spacing={1} alignItems="center">
      <Typography level="body-sm" sx={{ flex: 1 }}>
        {job.output.aspectRatio} ({job.output.width}x{job.output.height})
      </Typography>
      <Chip
        size="sm"
        variant="soft"
        color={STATE_COLOR[job.state]}
        data-testid={`production-export-job-state-${job.id}`}
      >
        {STATE_LABEL[job.state]}
      </Chip>
      {job.state === 'succeeded' && <DownloadLink job={job} />}
    </Stack>
    {job.state === 'running' && (
      <LinearProgress
        determinate={job.progress !== null}
        value={(job.progress ?? 0) * 100}
        data-testid={`production-export-job-progress-${job.id}`}
      />
    )}
    {(job.state === 'failed' || job.state === 'blocked') && (
      <Typography level="body-xs" color="danger" data-testid={`production-export-job-error-${job.id}`}>
        {/* The server's public message already states the refund (studioRenderJobResponse.ts). */}
        {job.error?.message ?? 'The render did not finish. Held credits are refunded.'}
      </Typography>
    )}
  </Stack>
);

const RecentExports = ({ compositionId }: { compositionId: string }) => {
  const { data: jobs = [] } = useStudioRenders(compositionId);
  if (jobs.length === 0) return null;
  return (
    <Stack spacing={1.5} data-testid="production-export-recent">
      <Divider />
      <Typography level="title-sm">Recent exports</Typography>
      {groupByGroupId(jobs).map(group => (
        <Stack key={group[0].groupId} spacing={1} data-testid={`production-export-group-${group[0].groupId}`}>
          {group.map(job => (
            <JobRow key={job.id} job={job} />
          ))}
        </Stack>
      ))}
    </Stack>
  );
};

export const ExportPanel = ({ compositionId, timeline, canExport }: ExportPanelProps) => {
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const pricing = useRenderPricing();
  const create = useCreateStudioRenders(compositionId);
  const { data: jobs = [] } = useStudioRenders(compositionId);

  const clipsPresent = hasClips(timeline);
  const disabledReason = !clipsPresent
    ? 'Add a clip to export.'
    : !canExport
      ? 'Wait for the production to save.'
      : null;
  const creditsFor = (aspectRatio: StudioTimeline['outputs'][number]['aspectRatio']) =>
    usdToCredits(estimateStudioRenderUsd(timeline, aspectRatio, pricing));
  const selected = timeline.outputs.filter(output => selectedIds.has(output.id));
  const totalCredits = selected.reduce((sum, output) => sum + creditsFor(output.aspectRatio), 0);
  const exporting = jobs.some(isRenderInFlight);

  const toggle = (outputId: string) =>
    setSelectedIds(previous => {
      const next = new Set(previous);
      if (!next.delete(outputId)) next.add(outputId);
      return next;
    });

  const submit = () => {
    create.mutate(
      selected.map(output => output.id),
      { onSuccess: () => setSelectedIds(new Set()) }
    );
  };

  return (
    <>
      <Tooltip title={disabledReason ?? ''} disableHoverListener={disabledReason === null}>
        <Box component="span" sx={{ display: 'inline-flex' }}>
          <Button
            size="sm"
            variant="soft"
            disabled={disabledReason !== null}
            onClick={() => setOpen(true)}
            data-testid="production-export-open-btn"
          >
            {exporting ? 'Exporting...' : 'Export'}
          </Button>
        </Box>
      </Tooltip>
      <Modal open={open} onClose={() => setOpen(false)}>
        <ModalDialog data-testid="production-export-dialog" sx={{ width: 'min(480px, 92vw)', overflowY: 'auto' }}>
          <ModalClose />
          <DialogTitle>Export</DialogTitle>
          <Stack spacing={1.5}>
            <Typography level="body-sm">Pick the sizes to render. Each one is rendered as its own MP4.</Typography>
            {timeline.outputs.map(output => (
              <Checkbox
                key={output.id}
                checked={selectedIds.has(output.id)}
                onChange={() => toggle(output.id)}
                label={`${output.aspectRatio} (${output.width}x${output.height}) - about ${creditsFor(output.aspectRatio)} credits`}
                slotProps={{ input: { 'data-testid': `production-export-output-checkbox-${output.id}` } }}
              />
            ))}
            {create.isError && (
              <Typography level="body-sm" color="danger" role="alert" data-testid="production-export-error">
                {renderErrorMessage(create.error)}
              </Typography>
            )}
            <Button
              loading={create.isPending}
              disabled={selected.length === 0 || disabledReason !== null}
              onClick={submit}
              data-testid="production-export-submit-btn"
            >
              {selected.length > 0 ? `Export ${selected.length} (about ${totalCredits} credits)` : 'Export'}
            </Button>
            <RecentExports compositionId={compositionId} />
          </Stack>
        </ModalDialog>
      </Modal>
    </>
  );
};
