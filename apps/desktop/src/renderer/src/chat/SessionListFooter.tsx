import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { SESSION_PAGE_SIZE } from '@shared/sessionPage';
import { useLoadMoreSentinel } from './useLoadMoreSentinel';

/** The sidebar's view of useSessions' paging. */
export interface SessionListPaging {
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Sessions in the whole list, loaded or not. */
  total: number;
}

const FOOTER_SX = { px: 1, py: 0.75, minHeight: '28px' } as const;

/**
 * The end of the sidebar list: a sentinel that loads the next page as it scrolls into view, a
 * loading row while that page is on its way, and a line saying the list is complete. The end line
 * shows only for a list long enough to have paged, where it answers "is that everything?".
 */
export function SessionListFooter({ paging, scrollRoot }: { paging: SessionListPaging; scrollRoot: Element | null }) {
  const { hasMore, loadingMore, onLoadMore, total } = paging;
  const sentinel = useLoadMoreSentinel({ hasMore, loading: loadingMore, onLoadMore, root: scrollRoot });

  if (hasMore) {
    return (
      <Box ref={sentinel.ref} sx={FOOTER_SX} data-testid="sidebar-load-more-sentinel">
        {loadingMore ? (
          <Stack direction="row" alignItems="center" gap={1} data-testid="sidebar-load-more-loading">
            <CircularProgress
              size="sm"
              sx={{
                '--CircularProgress-size': '14px',
                '--CircularProgress-trackThickness': '2px',
                '--CircularProgress-progressThickness': '2px',
              }}
            />
            <Typography level="body-xs" textColor="text.tertiary">
              Loading more conversations...
            </Typography>
          </Stack>
        ) : (
          sentinel.stalled && (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={onLoadMore}
              sx={{ fontWeight: 'normal', px: 1 }}
              data-testid="sidebar-load-more-btn"
            >
              Show older conversations
            </Button>
          )
        )}
      </Box>
    );
  }

  if (total <= SESSION_PAGE_SIZE) return null;
  return (
    <Typography level="body-xs" textColor="text.tertiary" sx={FOOTER_SX} data-testid="sidebar-list-end">
      No older conversations
    </Typography>
  );
}
