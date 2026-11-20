import { useState } from 'react';
import { Box, Button, Drawer, IconButton, LinearProgress, Stack, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import dayjs from 'dayjs';
import { isValidSupportCase } from '@client/shared/supportCase';
import { useModelLogDetail, type ModelLogSummary } from '@client/app/hooks/useModelLogs';
import { ErrorState, Fact, SectionCard } from './shared';
import { adminFocusScope } from './shared/adminStyles';

export const formatLogTime = (timestamp: string) => dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss');
export const formatCount = (value: number | undefined) => (value === undefined ? undefined : value.toLocaleString());

// The full promptMeta is fetched only on request; the list response carries just the summary fields.
// It is the user's own prompt text, so it is a support read and needs a case.
const PromptDetails = ({ id, supportCase }: { id: string; supportCase: string }) => {
  const [expanded, setExpanded] = useState(false);
  const hasSupportCase = isValidSupportCase(supportCase);
  const detailQuery = useModelLogDetail(id, supportCase, expanded);

  return (
    <Stack gap={1} sx={{ px: 2, py: 1.75 }}>
      <Typography level="body-sm" sx={{ color: 'admin.inkSecondary' }}>
        {hasSupportCase
          ? 'Reading the prompt is recorded against the support case you entered.'
          : 'Enter a support case above the table to read the prompt.'}
      </Typography>
      <Button
        size="sm"
        variant="outlined"
        color="neutral"
        onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded}
        disabled={!hasSupportCase}
        sx={{ alignSelf: 'flex-start' }}
        data-testid="model-logs-details-toggle-btn"
      >
        {expanded ? 'Hide prompt details' : 'Show prompt details'}
      </Button>
      {expanded &&
        hasSupportCase &&
        (detailQuery.isError ? (
          <ErrorState message="Could not load log details." onRetry={() => detailQuery.refetch()} />
        ) : detailQuery.data ? (
          <Box
            component="pre"
            data-testid="model-logs-details"
            sx={{
              m: 0,
              p: 1.5,
              maxHeight: 480,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'code',
              fontSize: 'xs',
              color: 'admin.ink',
              bgcolor: 'admin.surfaceSubtle',
              border: '1px solid',
              borderColor: 'admin.border',
              borderRadius: '8px',
            }}
          >
            {JSON.stringify(detailQuery.data, null, 2)}
          </Box>
        ) : (
          <LinearProgress size="sm" data-testid="model-logs-details-loading" />
        ))}
    </Stack>
  );
};

/** One model log in full: the summary the list already has, its artifacts, and the prompt on request. */
export const ModelLogDrawer = ({
  log,
  supportCase,
  onClose,
}: {
  log: ModelLogSummary | undefined;
  supportCase: string;
  onClose: () => void;
}) => (
  <Drawer
    anchor="right"
    open={Boolean(log)}
    onClose={onClose}
    slotProps={{
      content: {
        'aria-labelledby': 'model-log-drawer-title',
        sx: {
          width: { xs: '100%', md: 'min(40rem, 100%)' },
          bgcolor: 'admin.surface',
          color: 'admin.ink',
          boxShadow: 'lg',
          p: 0,
        },
      },
    }}
    data-testid="model-logs-drawer"
  >
    {log && (
      <Stack sx={{ height: '100%', minHeight: 0, ...adminFocusScope }}>
        <Stack
          direction="row"
          alignItems="center"
          gap={1}
          sx={{ px: 2.5, py: 1.5, borderBottom: '1px solid', borderColor: 'admin.border' }}
        >
          <Typography id="model-log-drawer-title" level="title-lg" component="h2" sx={{ mr: 'auto' }}>
            Model log
          </Typography>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Close"
            onClick={onClose}
            data-testid="model-logs-drawer-close-btn"
          >
            <CloseIcon />
          </IconButton>
        </Stack>
        <Stack gap={2} sx={{ p: 2.5, overflow: 'auto', minHeight: 0 }}>
          <SectionCard title="Summary" data-testid="model-logs-drawer-summary">
            <Fact label="Model">{log.modelName}</Fact>
            <Fact label="Time">{formatLogTime(log.timestamp)}</Fact>
            <Fact label="Response time">
              {log.totalResponseTime === undefined ? undefined : `${formatCount(log.totalResponseTime)} ms`}
            </Fact>
            <Fact label="Input tokens">{formatCount(log.inputTokens)}</Fact>
            <Fact label="Output tokens">{formatCount(log.outputTokens)}</Fact>
            <Fact label="Attached files">{formatCount(log.attachedFileCount)}</Fact>
            <Fact label="Message history">{formatCount(log.messageHistoryLength)}</Fact>
            <Fact label="Steps completed">{formatCount(log.completedStepCount)}</Fact>
            <Fact label="Steps failed">{formatCount(log.failedStepCount)}</Fact>
          </SectionCard>
          {log.artifacts.length > 0 && (
            <SectionCard title={`Artifacts (${log.artifacts.length})`} body="custom">
              <Stack component="ul" gap={0.5} sx={{ m: 0, px: 2, py: 1.75, listStyle: 'none' }}>
                {log.artifacts.map((artifact, index) => (
                  <Typography key={index} component="li" level="body-sm" sx={{ color: 'admin.ink' }}>
                    {artifact.type}
                  </Typography>
                ))}
              </Stack>
            </SectionCard>
          )}
          <SectionCard title="Prompt details" body="custom">
            {/* Keyed by log so moving to another log starts collapsed and never fetches on its own. */}
            <PromptDetails key={log.id} id={log.id} supportCase={supportCase} />
          </SectionCard>
        </Stack>
      </Stack>
    )}
  </Drawer>
);
