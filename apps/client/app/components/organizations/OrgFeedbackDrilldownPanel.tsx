import { OrgFeedbackItem } from '@bike4mind/common';
import {
  useOrgFeedbackItem,
  useOrgFeedbackItems,
  type OrgFeedbackRange,
} from '@client/app/hooks/data/orgFeedbackReport';
import { getErrorMessage } from '@client/app/utils/error';
import { Alert, Box, Button, CircularProgress, Sheet, Stack, Typography } from '@mui/joy';
import { FC, useState } from 'react';

const ItemDetail: FC<{ organizationId: string; feedbackId: string }> = ({ organizationId, feedbackId }) => {
  const { data, isFetching, isError, error } = useOrgFeedbackItem(organizationId, feedbackId);

  if (isFetching) return <CircularProgress size="sm" data-testid="org-analysis-item-loading" />;
  if (isError)
    return (
      <Alert color="danger" data-testid="org-analysis-item-error">
        {getErrorMessage(error)}
      </Alert>
    );
  if (!data) return null;

  const item: OrgFeedbackItem = data;
  return (
    <Stack spacing={0.5} sx={{ pl: 2 }} data-testid="org-analysis-item-detail">
      <Typography level="body-sm">Reported by {item.username}</Typography>
      <Typography level="body-sm">Status {item.status}</Typography>
      <Typography level="body-sm">Type {item.type ?? 'unspecified'}</Typography>
      {item.tags.length > 0 && <Typography level="body-sm">Tags {item.tags.join(', ')}</Typography>}
      {/* The report is metadata only by rule; verbatim stays behind the reporter's own read route. */}
      <Typography level="body-xs" data-testid="org-analysis-item-content-note">
        {item.contentStored ? 'Text is on file, and is not shown here.' : 'Text is no longer on file.'}
      </Typography>
    </Stack>
  );
};

/**
 * The rows behind one report cell, and one row's metadata under it.
 *
 * Only `subject` reaches the list route as a filter, so this opens from the By subject cells - the
 * other groupings have nothing to narrow the list by and would show the whole window instead.
 */
const OrgFeedbackDrilldownPanel: FC<{ organizationId: string; range: OrgFeedbackRange; subject: string }> = ({
  organizationId,
  range,
  subject,
}) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isFetching, isError, error } = useOrgFeedbackItems(organizationId, range, subject);

  return (
    <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'sm' }} data-testid="org-analysis-drilldown">
      <Typography level="title-sm" sx={{ mb: 1 }} data-testid="org-analysis-drilldown-title">
        Reports with subject {subject}
      </Typography>

      {isFetching && <CircularProgress size="sm" data-testid="org-analysis-drilldown-loading" />}

      {isError && (
        <Alert color="danger" data-testid="org-analysis-drilldown-error">
          {getErrorMessage(error)}
        </Alert>
      )}

      {!isFetching && !isError && data && data.items.length === 0 && (
        <Typography level="body-sm" data-testid="org-analysis-drilldown-empty">
          No reports behind this count.
        </Typography>
      )}

      {!isFetching && !isError && data && data.items.length > 0 && (
        <Stack spacing={1}>
          {data.items.map(item => (
            <Box key={item.id}>
              <Button
                variant="plain"
                size="sm"
                data-testid={`org-analysis-drilldown-row-${item.id}`}
                onClick={() => setOpenId(current => (current === item.id ? null : item.id))}
              >
                {item.createdAt.slice(0, 10)} - {item.username} - {item.status}
              </Button>
              {openId === item.id && <ItemDetail organizationId={organizationId} feedbackId={item.id} />}
            </Box>
          ))}
          {data.total > data.items.length && (
            <Typography level="body-xs" data-testid="org-analysis-drilldown-truncated">
              Showing {data.items.length} of {data.total}. Narrow the window to see the rest.
            </Typography>
          )}
        </Stack>
      )}
    </Sheet>
  );
};

export default OrgFeedbackDrilldownPanel;
