import { IOrganizationDocument } from '@bike4mind/common';
import FeedbackCountsPanel from '@client/app/components/organizations/FeedbackCountsPanel';
import OrgFeedbackSummaryPanel from '@client/app/components/organizations/OrgFeedbackSummaryPanel';
import type { OrgFeedbackRange } from '@client/app/hooks/data/orgFeedbackReport';
import { Button, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { FC, useState } from 'react';

const DEFAULT_WINDOW_DAYS = 30;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

const defaultRange = (): OrgFeedbackRange => {
  const to = new Date();
  // Inclusive of both endpoints, so DEFAULT_WINDOW_DAYS calendar days means subtracting one fewer.
  const from = new Date(to.getTime() - (DEFAULT_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000);
  return { from: isoDay(from), to: isoDay(to) };
};

/**
 * The org's feedback analysis. This shell owns the window and the run trigger; each panel below
 * reads the applied window through its own hook, so they stay independent of one another.
 *
 * Nothing runs on mount. The report is an aggregate over the whole feedback collection and the
 * route rate limits it, so a window is only fetched once someone asks for it - and `applied` being
 * separate from the draft dates is what keeps a half-typed date out of the query key.
 */
const OrganizationAnalysisSection: FC<{ organization: IOrganizationDocument }> = ({ organization }) => {
  const [draft, setDraft] = useState<OrgFeedbackRange>(defaultRange);
  const [applied, setApplied] = useState<OrgFeedbackRange | null>(null);

  const invalid = draft.from === '' || draft.to === '' || draft.from > draft.to;

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="flex-end" flexWrap="wrap" useFlexGap>
        <FormControl>
          <FormLabel>From</FormLabel>
          <Input
            type="date"
            value={draft.from}
            slotProps={{ input: { 'data-testid': 'org-analysis-date-from', max: draft.to } }}
            onChange={event => setDraft(current => ({ ...current, from: event.target.value }))}
          />
        </FormControl>
        <FormControl>
          <FormLabel>To</FormLabel>
          <Input
            type="date"
            value={draft.to}
            slotProps={{ input: { 'data-testid': 'org-analysis-date-to', min: draft.from } }}
            onChange={event => setDraft(current => ({ ...current, to: event.target.value }))}
          />
        </FormControl>
        <Button data-testid="org-analysis-run-button" disabled={invalid} onClick={() => setApplied(draft)}>
          Run report
        </Button>
      </Stack>

      {invalid && (
        <Typography level="body-sm" color="danger" data-testid="org-analysis-range-error">
          Pick a start date on or before the end date.
        </Typography>
      )}

      {applied === null ? (
        <Typography level="body-md" data-testid="org-analysis-idle">
          Choose a window and run the report to see what this organization has been reporting.
        </Typography>
      ) : (
        <Stack spacing={3}>
          <FeedbackCountsPanel organizationId={organization.id} range={applied} />
          <OrgFeedbackSummaryPanel organizationId={organization.id} range={applied} />
        </Stack>
      )}
    </Stack>
  );
};

export default OrganizationAnalysisSection;
