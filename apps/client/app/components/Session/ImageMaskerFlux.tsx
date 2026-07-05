import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Button, Box, Slider, Textarea, Typography, CircularProgress, ModalDialog } from '@mui/joy';

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

// ImageMaskerFlux produces a black-and-white mask (white = brushed area),
// the mask format required by the Black Forest Flux image-edit endpoint.
const ImageMaskerFlux: React.FC<ImageMaskerProps> = ({ imageUrl, onSave, open, onClose }) => {
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [lastPoint, setLastPoint] = useState<Point | null>(null);
  const [brushSize, setBrushSize] = useState<number>(50);
  const [promptMessage, setPromptMessage] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const originalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const initializeCanvases = useCallback(
    (image: HTMLImageElement) => {
      const originalCanvas = originalCanvasRef.current;
      const maskCanvas = maskCanvasRef.current;

      if (originalCanvas && maskCanvas) {
        console.log('drawing image');
        // Set both canvases to image dimensions
        originalCanvas.width = image.width;
        originalCanvas.height = image.height;
        maskCanvas.width = image.width;
        maskCanvas.height = image.height;

        // Draw image on original canvas
        const originalCtx = originalCanvas.getContext('2d');
        if (originalCtx) {
          originalCtx.drawImage(image, 0, 0);
          originalCtx.strokeStyle = 'white';
          originalCtx.lineWidth = brushSize;
          originalCtx.lineCap = 'round';
        }

        // Initialize mask canvas with black (no modification)
        const maskCtx = maskCanvas.getContext('2d');
        if (maskCtx) {
          maskCtx.fillStyle = 'black';
          maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);

          // Set drawing properties
          maskCtx.strokeStyle = 'white';
          maskCtx.lineWidth = brushSize;
          maskCtx.lineCap = 'round';
        }
        setIsLoading(false);
      }
    },
    [brushSize]
  );

  // Initialize canvases with image
  useEffect(() => {
    setIsLoading(true);
    const image = new Image();
    image.src = imageUrl;

    image.onload = () => {
      imageRef.current = image;
      console.log('loading image');
      initializeCanvases(image);
    };

    image.onerror = () => {
      console.error('Failed to load image');
      setIsLoading(false);
    };

    return () => {
      // Cleanup
      image.onload = null;
      image.onerror = null;
    };
  }, [imageUrl, open, initializeCanvases]);

  const getCanvasPoint = (e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = maskCanvasRef.current;
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
    const ctx = maskCanvasRef.current?.getContext('2d');

    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(lastPoint.x, lastPoint.y);
      ctx.lineTo(currentPoint.x, currentPoint.y);
      ctx.stroke();
      setLastPoint(currentPoint);
    }
  };

  const stopDrawing = () => {
    setIsDrawing(false);
    setLastPoint(null);
  };

  const generateMaskBase64 = (): string => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return '';

    // Convert the mask canvas to base64
    return maskCanvas.toDataURL('image/png').split(',')[1];
  };

  const handleSave = async () => {
    try {
      setIsLoading(true);
      const maskBase64 = generateMaskBase64();
      await onSave(imageUrl, maskBase64, promptMessage);
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
        onClose={() => onClose()}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ModalDialog>
          <Box
            sx={{
              padding: 2,
              borderRadius: 2,
              maxWidth: '90vw',
              maxHeight: '90vh',
              overflow: 'auto',
              backgroundColor: 'background.paper',
            }}
          >
            <Typography level="h2" data-testid="image-edit-dialog-title">
              Edit Image
            </Typography>
            <Box
              sx={{
                position: 'relative',
                minHeight: 200,
                maxHeight: '60vh',
                overflow: 'hidden',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              {/* Original image canvas (background) */}
              <canvas
                ref={originalCanvasRef}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  maxWidth: '100%',
                  height: 'auto',
                }}
              />
              {/* Mask canvas (overlay) */}
              <canvas
                ref={maskCanvasRef}
                style={{
                  position: 'relative',
                  maxWidth: '100%',
                  height: 'auto',
                  opacity: 0.5, // Make the mask semi-transparent for better visibility
                }}
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onMouseOut={stopDrawing}
              />
              {isLoading && (
                <CircularProgress
                  size="lg"
                  style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              )}
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
              <Button variant="outlined" onClick={() => onClose()} data-testid="image-edit-cancel-btn">
                Cancel
              </Button>
              <Button onClick={handleSave} data-testid="image-edit-save-btn">
                Save
              </Button>
            </Box>
          </Box>
        </ModalDialog>
      </Modal>
    </>
  );
};

export default ImageMaskerFlux;
