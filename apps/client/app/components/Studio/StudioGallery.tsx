import { Fragment, type ReactNode } from 'react';
import { Box, Button, CircularProgress, Stack, Typography } from '@mui/joy';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import PhotoLibraryOutlinedIcon from '@mui/icons-material/PhotoLibraryOutlined';
import { StudioTakesGrid, StudioTakesLoading, StudioTakesMessage } from './design/StudioTakesStates';
import { studioColor, studioRadius } from './design/studioTokens';

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
  // A modality's infinite list query (useGenerationJobs, useRecentGeneratedAudio).
  query: GalleryQuery<TItem>;
  // A job card reads its own job by id, so websocket patches to one job re-render only its card.
  renderCard: (item: TItem) => ReactNode;
  // 'takes' draws the Studio-token takes gallery and its states, so it needs a StudioThemeScope above it (Create v2).
  // 'cards' is the stock Joy look the legacy Studio page still renders.
  variant?: 'cards' | 'takes';
};

const TAKES_LOAD_MORE_SX = {
  alignSelf: 'center',
  borderRadius: studioRadius('md'),
  borderColor: studioColor('border'),
  color: studioColor('text'),
  '&:hover': { backgroundColor: studioColor('hover'), borderColor: studioColor('border-strong') },
} as const;

/** A Studio tab's gallery: the user's generations of one kind, newest first, one card each, paged with "Load more". */
const StudioGallery = <TItem extends { id: string }>({
  testId,
  noun,
  query,
  renderCard,
  variant = 'cards',
}: StudioGalleryProps<TItem>) => {
  const { data, isPending, isFetchNextPageError, hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const takes = variant === 'takes';
  const emptyMessage = `${noun.charAt(0).toUpperCase() + noun.slice(1)} you generate will appear here.`;

  if (isPending) {
    return takes ? (
      <StudioTakesLoading testId={`${testId}-loading`} label={`Loading your ${noun}`} />
    ) : (
      <CircularProgress size="sm" data-testid={`${testId}-loading`} />
    );
  }
  if (!data) {
    if (takes) {
      return (
        <StudioTakesMessage tone="danger" icon={<ErrorOutlineIcon />} testId={`${testId}-error`}>
          Could not load your {noun}. Refresh to try again.
        </StudioTakesMessage>
      );
    }
    return (
      <Typography level="body-sm" color="danger" data-testid={`${testId}-error`}>
        Could not load your {noun}. Refresh to try again.
      </Typography>
    );
  }

  // An item created after page 1 was fetched shifts the later pages, so a later page can repeat a row.
  const items = [...new Map(data.pages.flatMap(page => page.data).map(item => [item.id, item] as const)).values()];
  if (items.length === 0) {
    return takes ? (
      <StudioTakesMessage icon={<PhotoLibraryOutlinedIcon />} testId={`${testId}-empty`}>
        {emptyMessage}
      </StudioTakesMessage>
    ) : (
      <Typography level="body-sm" data-testid={`${testId}-empty`}>
        {emptyMessage}
      </Typography>
    );
  }

  const cards = items.map(item => <Fragment key={item.id}>{renderCard(item)}</Fragment>);
  return (
    <Stack gap={2} data-testid={testId}>
      {takes ? (
        <StudioTakesGrid>{cards}</StudioTakesGrid>
      ) : (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {cards}
        </Box>
      )}
      {isFetchNextPageError &&
        (takes ? (
          <StudioTakesMessage tone="danger" inline testId={`${testId}-load-more-error`}>
            Could not load more {noun}. Try again.
          </StudioTakesMessage>
        ) : (
          <Typography level="body-sm" color="danger" textAlign="center" data-testid={`${testId}-load-more-error`}>
            Could not load more {noun}. Try again.
          </Typography>
        ))}
      {hasNextPage && (
        <Button
          variant="outlined"
          color="neutral"
          loading={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
          sx={takes ? TAKES_LOAD_MORE_SX : { alignSelf: 'center' }}
          data-testid={`${testId}-load-more-btn`}
        >
          Load more
        </Button>
      )}
    </Stack>
  );
};

export default StudioGallery;
