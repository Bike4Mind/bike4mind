import { FC } from 'react';
import { Box, Typography } from '@mui/joy';

interface ImageDisplayProps {
  imageUrl?: string;
  error?: Error;
  onRetrySuccess?: (newImageUrl: string) => void;
}

const ImageDisplay: FC<ImageDisplayProps> = ({ imageUrl, error }) => {
  return (
    <Box className="image-display" sx={{ position: 'relative', width: '100%', minHeight: '200px' }}>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt="Generated"
          style={{
            width: '100%',
            height: 'auto',
            borderRadius: '8px',
          }}
        />
      ) : error ? (
        <Box
          sx={{
            p: 2,
            border: '1px solid',
            borderColor: 'error.main',
            borderRadius: '8px',
            bgcolor: 'error.softBg',
          }}
        >
          <Typography color="danger">{error.message}</Typography>
        </Box>
      ) : (
        <Box
          sx={{
            p: 2,
            border: '1px dashed',
            borderColor: 'neutral.outlinedBorder',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Typography level="body-sm" color="neutral">
            No image available
          </Typography>
        </Box>
      )}
    </Box>
  );
};

export default ImageDisplay;
