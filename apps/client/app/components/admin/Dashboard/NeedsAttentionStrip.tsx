import { Box, Button, Stack, Typography } from '@mui/joy';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import {
  ADMIN_ACTION_COUNT_LABELS,
  formatAdminActionCount,
  type AdminActionCountKey,
  type AdminActionCounts,
} from '@bike4mind/server-utils/app/components/admin/adminActionCounts';
import { useAdminActionCounts } from '@client/app/hooks/data/adminActionCounts';
import { canUseCampaignWatches, useCampaignWatches } from '@client/app/hooks/data/campaignWatches';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { adminTabFromSlug } from '../adminTabSlugs';
import type { AdminTab } from '../adminSidebarConfig';
import { ErrorState, LoadingState } from '../shared';
import { ACTION_COUNT_TABS } from './dashboardNav';

type AttentionItem = { id: string; count: string; label: string; tab: AdminTab; sortKey: number };

const CAMPAIGN_WATCHES_SLUG = 'shadow-detections';

/** Queues with work waiting, most first. Zero and failed counts are returned separately. */
export function splitActionCounts(counts: AdminActionCounts) {
  const waiting: AttentionItem[] = [];
  const clear: AdminActionCountKey[] = [];
  const failed: AdminActionCountKey[] = [];
  for (const [key, value] of Object.entries(counts) as [AdminActionCountKey, number | null | undefined][]) {
    const tab = ACTION_COUNT_TABS.get(key);
    if (value === null) failed.push(key);
    else if (!value) clear.push(key);
    else if (tab !== undefined)
      waiting.push({
        id: key,
        count: formatAdminActionCount(value),
        label: ADMIN_ACTION_COUNT_LABELS[key],
        tab,
        sortKey: value,
      });
  }
  waiting.sort((a, b) => b.sortKey - a.sortKey);
  return { waiting, clear, failed };
}

function useOpenWatchItem(): AttentionItem | null {
  const { currentUser } = useUser();
  const watches = useCampaignWatches('open', canUseCampaignWatches(currentUser));
  const tab = adminTabFromSlug(CAMPAIGN_WATCHES_SLUG);
  const firstPage = watches.data?.pages[0];
  if (!firstPage || firstPage.items.length === 0 || tab === undefined) return null;
  const count = firstPage.items.length;
  return {
    id: 'campaignWatches',
    count: firstPage.nextCursor ? `${count}+` : String(count),
    label: count === 1 ? 'open campaign watch' : 'open campaign watches',
    tab,
    sortKey: count,
  };
}

const listFormat = (keys: readonly AdminActionCountKey[]) => keys.map(key => ADMIN_ACTION_COUNT_LABELS[key]).join(', ');

/** The queues that need a person today, linked to the tab that works each one; replaces the morning brief's to-do list. */
export function NeedsAttentionStrip({ onNavigate }: { onNavigate: (tab: AdminTab) => void }) {
  const impersonating = useAccessToken(state => state.impersonating);
  // Same query key as the sidebar badges, so this adds no request.
  const counts = useAdminActionCounts({ enabled: !impersonating });
  const watchItem = useOpenWatchItem();

  if (counts.isLoading) return <LoadingState label="Loading queues" />;
  if (counts.isError || !counts.data)
    return <ErrorState message="Queue counts could not be loaded." onRetry={() => void counts.refetch()} />;

  const { waiting, clear, failed } = splitActionCounts(counts.data);
  const items = watchItem ? [...waiting, watchItem] : waiting;

  return (
    <Stack gap={1} data-testid="admin-dashboard-attention">
      {items.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {items.map(item => (
            <Button
              key={item.id}
              variant="outlined"
              color="neutral"
              onClick={() => onNavigate(item.tab)}
              data-testid={`admin-dashboard-attention-${item.id}`}
              sx={{ gap: 1, justifyContent: 'flex-start', fontWeight: 400 }}
            >
              <Typography component="span" sx={{ fontWeight: 600, fontSize: 16, fontVariantNumeric: 'tabular-nums' }}>
                {item.count}
              </Typography>
              {item.label}
            </Button>
          ))}
        </Box>
      )}
      {items.length === 0 ? (
        <Typography
          level="body-sm"
          startDecorator={<CheckCircleOutlineIcon color="success" />}
          data-testid="admin-dashboard-attention-all-clear"
        >
          All clear: no queue is waiting on a person.
        </Typography>
      ) : (
        clear.length > 0 && (
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="admin-dashboard-attention-clear">
            Nothing waiting: {listFormat(clear)}.
          </Typography>
        )
      )}
      {failed.length > 0 && (
        <Typography level="body-xs" color="warning" data-testid="admin-dashboard-attention-failed">
          Could not count: {listFormat(failed)}.
        </Typography>
      )}
    </Stack>
  );
}
