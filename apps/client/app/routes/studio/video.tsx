import { CircularProgress, Stack, Typography } from '@mui/joy';
import PageFrame from '@client/app/components/common/PageFrame';
import VideoGallery from '@client/app/components/VideoStudio/VideoGallery';
import VideoStudioForm from '@client/app/components/VideoStudio/VideoStudioForm';
import { useCreateVideoGeneration, useVideoModels } from '@client/app/hooks/data/videoGenerations';

const VideoStudioPage = () => {
  const models = useVideoModels();
  const create = useCreateVideoGeneration();

  const renderForm = () => {
    if (models.isPending) return <CircularProgress size="sm" data-testid="video-studio-loading" />;
    if (!models.data) {
      return (
        <Typography level="body-sm" color="danger" data-testid="video-studio-error">
          Could not load the video models. Refresh to try again.
        </Typography>
      );
    }
    if (models.data.length === 0) {
      return (
        <Typography level="body-sm" data-testid="video-studio-empty">
          Video generation is not available for your account yet.
        </Typography>
      );
    }
    return (
      <VideoStudioForm models={models.data} isSubmitting={create.isPending} onSubmit={body => create.mutate(body)} />
    );
  };

  return (
    <PageFrame testId="video-studio-page">
      <Stack gap={3}>
        <Typography level="h2">Video Studio</Typography>
        {renderForm()}
        <Typography level="title-lg">Your videos</Typography>
        <VideoGallery />
      </Stack>
    </PageFrame>
  );
};

export default VideoStudioPage;
