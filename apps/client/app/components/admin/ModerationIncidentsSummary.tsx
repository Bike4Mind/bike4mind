import React from 'react';
import { Box, Skeleton } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { SETTING_TABS, settingsMap } from '@bike4mind/common';
import type { UseQueryResult } from '@tanstack/react-query';
import { Dash, ErrorState, StatStrip, StatTile, formatUtc, relativeTime } from './shared';
import { AnomalyBanner } from './shared/AnomalyBanner';
import {
  ADMIN_SETTINGS_SEARCH_PARAM,
  ADMIN_SETTINGS_SECTION_PARAM,
  ADMIN_SETTINGS_TAB_SLUG,
  adminSearchForTab,
  type AdminSearch,
} from './adminTabParams';
import type { ModerationIncidentSummary } from '@client/app/hooks/data/moderationIncidents';

type ReviewerListSetting = 'ImageModerationReviewerEmails' | 'ImageModerationEscalationEmails';

const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

const settingPlace = (key: ReviewerListSetting) =>
  `${settingsMap[key].name} in Admin settings, ${settingsMap[key].category}`;

/**
 * One banner per reviewer list that is empty while incidents wait for it. The action opens Admin
 * settings on the section holding that list, filtered to it.
 */
export const ModerationReviewerBanners: React.FC<{ summary: ModerationIncidentSummary | undefined }> = ({
  summary,
}) => {
  const navigate = useNavigate();
  if (!summary) return null;

  const openSetting = (key: ReviewerListSetting) => {
    const category = settingsMap[key].category;
    const section = Object.values(SETTING_TABS).find(tab =>
      (tab.categories as readonly string[]).includes(category ?? '')
    );
    void navigate({
      to: '/admin',
      search: (previous: AdminSearch) => ({
        ...adminSearchForTab(previous, ADMIN_SETTINGS_TAB_SLUG),
        [ADMIN_SETTINGS_SECTION_PARAM]: section?.id,
        [ADMIN_SETTINGS_SEARCH_PARAM]: key,
      }),
    });
  };

  return (
    <>
      {summary.needsReview > 0 && !summary.reviewersConfigured && (
        <AnomalyBanner
          headline={`${plural(summary.needsReview, 'incident is', 'incidents are')} waiting and no reviewer is set`}
          detail={`No reviewer is emailed until ${settingPlace('ImageModerationReviewerEmails')} has an address.`}
          actionLabel="Add reviewer emails"
          onAction={() => openSetting('ImageModerationReviewerEmails')}
          dismissKey={String(summary.needsReview)}
          testId="moderation-incidents-no-reviewers-banner"
          actionTestId="moderation-incidents-no-reviewers-action-btn"
          dismissTestId="moderation-incidents-no-reviewers-dismiss-btn"
        />
      )}
      {summary.escalated > 0 && !summary.escalationReviewersConfigured && (
        <AnomalyBanner
          headline={`${plural(summary.escalated, 'escalated incident is', 'escalated incidents are')} waiting and no second reviewer is set`}
          detail={`No second reviewer is emailed until ${settingPlace('ImageModerationEscalationEmails')} has an address.`}
          actionLabel="Add escalation emails"
          onAction={() => openSetting('ImageModerationEscalationEmails')}
          dismissKey={String(summary.escalated)}
          testId="moderation-incidents-no-escalation-reviewers-banner"
          actionTestId="moderation-incidents-no-escalation-reviewers-action-btn"
          dismissTestId="moderation-incidents-no-escalation-reviewers-dismiss-btn"
        />
      )}
    </>
  );
};

const Stat: React.FC<{ name: string; children: React.ReactNode }> = ({ name, children }) => (
  <span data-testid={`moderation-incidents-stat-${name}`}>{children}</span>
);

/** Totals across the whole review queue. A failed load stays in this region; the queue below still renders. */
export const ModerationIncidentsSummary: React.FC<{
  query: Pick<UseQueryResult<ModerationIncidentSummary>, 'data' | 'isError' | 'isFetching' | 'refetch'>;
  now: number;
}> = ({ query, now }) => {
  if (query.isError) {
    return (
      <Box data-testid="moderation-incidents-summary">
        <ErrorState
          message="Couldn't load the review totals."
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      </Box>
    );
  }

  const summary = query.data;
  const value = (name: string, render: (data: ModerationIncidentSummary) => React.ReactNode) => (
    <Stat name={name}>
      {summary ? render(summary) : <Skeleton variant="text" level="h3" width="3ch" data-testid="admin-stat-skeleton" />}
    </Stat>
  );
  const oldest = summary?.oldestPendingCreatedAt ? new Date(summary.oldestPendingCreatedAt) : null;
  const closedWithoutReport = summary ? summary.closed.noAction + summary.closed.falsePositive : 0;

  return (
    <Box data-testid="moderation-incidents-summary">
      <StatStrip aria-label="Moderation review totals">
        <StatTile
          label="Needs review"
          value={value('needs-review', data => data.needsReview.toLocaleString())}
          comparison={
            summary && summary.stuck > 0 ? (
              <Stat name="stuck">{`Plus ${plural(summary.stuck, 'report', 'reports')} stuck`}</Stat>
            ) : undefined
          }
        />
        <StatTile
          label="Oldest waiting"
          value={value('oldest-waiting', () =>
            oldest ? relativeTime(oldest, now) : <Dash title="Nothing is waiting" />
          )}
          comparison={oldest ? formatUtc(oldest) : undefined}
        />
        <StatTile label="With second reviewer" value={value('escalated', data => data.escalated.toLocaleString())} />
        <StatTile label="Reports recorded" value={value('reported', data => data.closed.reported.toLocaleString())} />
        <StatTile
          label="Closed without report"
          value={value('closed-without-report', () => closedWithoutReport.toLocaleString())}
          comparison={
            summary ? (
              <Stat name="closed-without-report-split">
                {`${summary.closed.noAction.toLocaleString()} correctly blocked, ${plural(summary.closed.falsePositive, 'false positive', 'false positives')}`}
              </Stat>
            ) : undefined
          }
        />
      </StatStrip>
    </Box>
  );
};
