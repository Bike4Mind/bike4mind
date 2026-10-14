import { Box, Button, CircularProgress, Stack, Typography } from '@mui/joy';
import { useVideoGenerations } from '@client/app/hooks/data/videoGenerations';
import VideoJobCard from './VideoJobCard';

const VideoGallery = () => {
  const { data, isPending, isFetchNextPageError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useVideoGenerations();

  if (isPending) return <CircularProgress size="sm" data-testid="video-gallery-loading" />;
  if (!data) {
    return (
      <Typography level="body-sm" color="danger" data-testid="video-gallery-error">
        Could not load your videos. Refresh to try again.
      </Typography>
    );
  }

  // A job created after page 1 was fetched shifts the cursor pages, so a later page can repeat a row.
  const jobIds = [...new Set(data.pages.flatMap(page => page.data.map(job => job.id)))];
  if (jobIds.length === 0) {
    return (
      <Typography level="body-sm" data-testid="video-gallery-empty">
        Videos you generate will appear here.
      </Typography>
    );
  }

  return (
    <Stack gap={2} data-testid="video-gallery">
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {jobIds.map(jobId => (
          <VideoJobCard key={jobId} jobId={jobId} />
        ))}
      </Box>
      {isFetchNextPageError && (
        <Typography level="body-sm" color="danger" textAlign="center" data-testid="video-gallery-load-more-error">
          Could not load more videos. Try again.
        </Typography>
      )}
      {hasNextPage && (
        <Button
          variant="outlined"
          color="neutral"
          loading={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
          sx={{ alignSelf: 'center' }}
          data-testid="video-gallery-load-more-btn"
        >
          Load more
        </Button>
      )}
    </Stack>
  );
};

export default VideoGallery;
