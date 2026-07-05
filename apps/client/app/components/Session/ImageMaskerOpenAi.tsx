import React, { useEffect, useRef, useState } from 'react';
import { Modal, Button, Box, Textarea, Typography, Slider, CircularProgress, ModalDialog } from '@mui/joy';
import { toast } from 'sonner';

interface ImageMaskerProps {
  imageUrl: string;
  onSave: (sourceImageUrl: string, maskBase64: string, promptMessage: string) => Promise<void>;
  open: boolean;
  onClose: () => void;
}

interface Point {
  x: number;
  y: number;
}

// ImageMaskerOpenAi produces a mask with transparent brushed areas,
// the mask format required by the OpenAI image-edit endpoint.
const ImageMaskerOpenAi: React.FC<ImageMaskerProps> = ({ imageUrl, onSave, open, onClose }) => {
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [lastPoint, setLastPoint] = useState<Point | null>(null);
  const [promptMessage, setPromptMessage] = useState<string>('');
  const [brushSize, setBrushSize] = useState<number>(50);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // Initialize canvases with image
  useEffect(() => {
    setIsLoading(true);
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = imageUrl;
    console.log('initializing image..');

    const handleError = () => {
      console.error('Failed to load image - CORS error or image failed to load');
      setIsLoading(false);
    };

    image.onload = () => {
      console.log('loading image..');
      imageRef.current = image;
      if (displayCanvasRef.current && maskCanvasRef.current) {
        console.log('drawing image..');
        const displayCanvas = displayCanvasRef.current;
        const maskCanvas = maskCanvasRef.current;
        try {
          // Set canvas dimensions to match image
          displayCanvas.width = image.width;
          displayCanvas.height = image.height;
          maskCanvas.width = image.width;
          maskCanvas.height = image.height;

          const displayCtx = displayCanvas.getContext('2d');
          const maskCtx = maskCanvas.getContext('2d');

          if (displayCtx && maskCtx) {
            // Draw image on display canvas
            displayCtx.drawImage(image, 0, 0);
            // Set display canvas drawing style (semi-transparent for visual feedback)
            displayCtx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
            displayCtx.lineWidth = brushSize;
            displayCtx.lineCap = 'round';

            // Draw image on mask canvas
            maskCtx.drawImage(image, 0, 0);
            // Set mask canvas drawing style (solid black for mask)
            maskCtx.strokeStyle = 'white';
            maskCtx.lineWidth = brushSize;
            maskCtx.lineCap = 'round';
          }
        } catch (err) {
          console.error('Error drawing image:', err);
          handleError();
          return;
        }
        setIsLoading(false);
      }
    };

    image.onerror = handleError;

    return () => {
      // Cleanup
      image.onload = null;
      image.onerror = null;
    };
  }, [imageUrl, brushSize]);

  const getCanvasPoint = (e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = displayCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDrawing(true);
    setLastPoint(getCanvasPoint(e));
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !lastPoint) return;

    const currentPoint = getCanvasPoint(e);
    const displayCtx = displayCanvasRef.current?.getContext('2d');
    const maskCtx = maskCanvasRef.current?.getContext('2d');

    if (displayCtx && maskCtx) {
      // Draw on display canvas (semi-transparent)
      displayCtx.beginPath();
      displayCtx.moveTo(lastPoint.x, lastPoint.y);
      displayCtx.lineTo(currentPoint.x, currentPoint.y);
      displayCtx.stroke();

      // Draw on mask canvas (solid black)
      maskCtx.beginPath();
      maskCtx.moveTo(lastPoint.x, lastPoint.y);
      maskCtx.lineTo(currentPoint.x, currentPoint.y);
      maskCtx.stroke();

      setLastPoint(currentPoint);
    }
  };

  const stopDrawing = () => {
    setIsDrawing(false);
    setLastPoint(null);
  };

  const generateMaskBase64 = (): string | null => {
    if (!maskCanvasRef.current) return null;
    const canvas = maskCanvasRef.current;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      // Create a temporary canvas for the mask
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const tempCtx = tempCanvas.getContext('2d');

      if (tempCtx) {
        // Copy the mask canvas
        tempCtx.drawImage(canvas, 0, 0);

        // Apply masking effect
        const imageData = tempCtx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        // Iterate through all pixels
        for (let i = 0; i < data.length; i += 4) {
          // Check if pixel is part of the mask (black)
          if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) {
            // Make pixel transparent
            data[i + 3] = 0;
          }
        }

        tempCtx.putImageData(imageData, 0, 0);
        return tempCanvas.toDataURL('image/png').split(',')[1];
      }
    }
    return null;
  };

  const handleSave = async () => {
    try {
      setIsLoading(true);
      const maskBase64 = generateMaskBase64();
      if (!maskBase64) {
        toast.error('No mask generated');
      } else {
        await onSave(imageUrl, maskBase64, promptMessage);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const clearMask = () => {
    const maskCtx = maskCanvasRef.current?.getContext('2d');
    if (maskCtx && maskCanvasRef.current) {
      maskCtx.fillStyle = 'black';
      maskCtx.fillRect(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ModalDialog>
          <Box
            sx={{
              backgroundColor: 'background.paper',
              padding: 2,
              borderRadius: 2,
              maxWidth: '90vw',
              maxHeight: '90vh',
              overflow: 'auto',
            }}
          >
            <Typography level="h2" data-testid="image-edit-dialog-title">
              Edit Image
            </Typography>
            <Box sx={{ position: 'relative', maxHeight: '60vh', overflow: 'hidden' }}>
              {isLoading && (
                <CircularProgress
                  size="lg"
                  style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    zIndex: 1,
                  }}
                />
              )}
              {/* Display canvas (visible to user) */}
              <canvas
                ref={displayCanvasRef}
                style={{
                  maxWidth: '100%',
                  height: 'auto',
                }}
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onMouseOut={stopDrawing}
              />
              {/* Hidden mask canvas */}
              <canvas
                ref={maskCanvasRef}
                style={{
                  display: 'none',
                }}
              />
            </Box>

            <Box sx={{ mt: 2 }}>
              <Typography level="body-sm">
                <strong>Brush Size:</strong> Adjust the size of the brush to control the level of detail in the mask.
              </Typography>
              <Slider
                value={brushSize}
                onChange={(_, value) => setBrushSize(value as number)}
                min={1}
                max={100}
                valueLabelDisplay="auto"
                aria-label="Brush size"
                data-testid="image-edit-brush-slider"
              />
            </Box>

            <Box sx={{ mt: 2 }}>
              <Typography level="body-sm">
                <strong>Prompt:</strong> The brushed areas indicate where the image should be edited, and the prompt
                should describe the full new image, <b>not just the brushed area</b>.
              </Typography>
              <Textarea
                variant="outlined"
                autoFocus
                value={promptMessage}
                onChange={e => setPromptMessage(e.target.value)}
                data-testid="image-edit-prompt"
                sx={{
                  '& .MuiOutlinedInput-root': {
                    backgroundColor: 'background.paper',
                  },
                }}
              />
            </Box>

            <Box sx={{ mt: 2, display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
              <Button variant="outlined" onClick={clearMask} data-testid="image-edit-clear-btn">
                Clear
              </Button>
              <Button variant="outlined" onClick={onClose} data-testid="image-edit-cancel-btn">
                Cancel
              </Button>
              <Button disabled={isLoading} onClick={handleSave} data-testid="image-edit-save-btn">
                Save
              </Button>
            </Box>
          </Box>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default ImageMaskerOpenAi;
