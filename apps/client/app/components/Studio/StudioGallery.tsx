import { Fragment, type ReactNode } from 'react';
import { Box, Button, CircularProgress, Stack, Typography } from '@mui/joy';

type GalleryQuery<TItem> = {
  data: { pages: readonly { data: readonly TItem[] }[] } | undefined;
  isPending: boolean;
  isFetchNextPageError: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
};

type StudioGalleryProps<TItem extends { id: string }> = {
  // `<testId>`, plus `-loading`, `-error`, `-empty`, `-load-more-error` and `-load-more-btn`.
  testId: string;
  // Plural, lower case: "videos", "songs".
  noun: string;
  // A modality's infinite list query (useVideoGenerations, useMusicGenerations, useRecentGeneratedAudio).
  query: GalleryQuery<TItem>;
  // A job card reads its own job by id, so websocket patches to one job re-render only its card.
  renderCard: (item: TItem) => ReactNode;
};

/** A Studio tab's gallery: the user's generations of one kind, newest first, one card each, paged with "Load more". */
const StudioGallery = <TItem extends { id: string }>({
  testId,
  noun,
  query,
  renderCard,
}: StudioGalleryProps<TItem>) => {
  const { data, isPending, isFetchNextPageError, hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  if (isPending) return <CircularProgress size="sm" data-testid={`${testId}-loading`} />;
  if (!data) {
    return (
      <Typography level="body-sm" color="danger" data-testid={`${testId}-error`}>
        Could not load your {noun}. Refresh to try again.
      </Typography>
    );
  }

  // An item created after page 1 was fetched shifts the later pages, so a later page can repeat a row.
  const items = [...new Map(data.pages.flatMap(page => page.data).map(item => [item.id, item] as const)).values()];
  if (items.length === 0) {
    return (
      <Typography level="body-sm" data-testid={`${testId}-empty`}>
        {noun.charAt(0).toUpperCase() + noun.slice(1)} you generate will appear here.
      </Typography>
    );
  }

  return (
    <Stack gap={2} data-testid={testId}>
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {items.map(item => (
          <Fragment key={item.id}>{renderCard(item)}</Fragment>
        ))}
      </Box>
      {isFetchNextPageError && (
        <Typography level="body-sm" color="danger" textAlign="center" data-testid={`${testId}-load-more-error`}>
          Could not load more {noun}. Try again.
        </Typography>
      )}
      {hasNextPage && (
        <Button
          variant="outlined"
          color="neutral"
          loading={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
          sx={{ alignSelf: 'center' }}
          data-testid={`${testId}-load-more-btn`}
        >
          Load more
        </Button>
      )}
    </Stack>
  );
};

export default StudioGallery;
