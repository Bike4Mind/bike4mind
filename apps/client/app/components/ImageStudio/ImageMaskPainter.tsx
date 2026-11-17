import { useRef, useState, type PointerEvent } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  Modal,
  ModalClose,
  ModalDialog,
  Slider,
  Typography,
} from '@mui/joy';
import { KnowledgeType } from '@bike4mind/common';
import type { ReferenceFile } from '@client/app/components/Studio/capabilityFields';
import { useGetFabFile } from '@client/app/hooks/data/fabFileQueries';
import {
  createFabFileOnServerWithUpload,
  deleteFileUtility,
  moderateFabFileNow,
} from '@client/app/utils/filesAPICalls';
import { hasPaintedPixels, strokesToMaskPixels } from './maskImage';

// Brush diameter as a percentage of the image's width, so it feels the same on any resolution.
const BRUSH_MIN = 1;
const BRUSH_MAX = 20;
const BRUSH_DEFAULT = 6;
const STROKE_COLOR = 'rgb(236, 72, 153)';

type ImageMaskPainterProps = {
  open: boolean;
  source: ReferenceFile;
  onClose: () => void;
  onSaved: (mask: ReferenceFile) => void;
};

type Point = { x: number; y: number };

const canvasPoint = (canvas: HTMLCanvasElement, event: PointerEvent<HTMLCanvasElement>): Point => {
  const box = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - box.left) / box.width) * canvas.width,
    y: ((event.clientY - box.top) / box.height) * canvas.height,
  };
};

async function uploadMask(strokeLayer: HTMLCanvasElement, sourceName: string): Promise<ReferenceFile> {
  const { width, height } = strokeLayer;
  const strokes = strokeLayer.getContext('2d')?.getImageData(0, 0, width, height);
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const context = output.getContext('2d');
  if (!strokes || !context) throw new Error('This browser cannot draw the mask.');
  context.putImageData(new ImageData(strokesToMaskPixels(strokes.data), width, height), 0, 0);
  const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The mask could not be saved as an image.');

  const fileName = `mask-${sourceName.replace(/\.[^.]+$/, '')}-${Date.now()}.png`;
  const saved = await createFabFileOnServerWithUpload(
    { type: KnowledgeType.FILE, fileName, mimeType: 'image/png', fileSize: blob.size },
    new File([blob], fileName, { type: 'image/png' })
  );
  // A job refuses an input still waiting on its upload scan, so scan the mask now instead of racing the S3 event.
  if ((await moderateFabFileNow(saved.id)) === 'blocked') {
    await deleteFileUtility(saved.id);
    throw new Error('The mask was blocked by moderation. Try drawing it again.');
  }
  return { fileId: saved.id, fileName };
}

/**
 * Paints a mask over the image being edited. The stroke layer is the image's natural size, so the saved mask lines up
 * with it pixel for pixel; the job path still rescales a mask whose upload was downsized.
 */
const ImageMaskPainter = ({ open, source, onClose, onSaved }: ImageMaskPainterProps) => {
  const sourceFile = useGetFabFile(open ? source.fileId : null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastPoint = useRef<Point | null>(null);
  const [brushPercent, setBrushPercent] = useState(BRUSH_DEFAULT);
  const [painted, setPainted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = sourceFile.data?.fileUrl;

  const sizeCanvasToImage = (image: HTMLImageElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    setPainted(false);
  };

  const paintTo = (canvas: HTMLCanvasElement, point: Point) => {
    const context = canvas.getContext('2d');
    if (!context) return;
    const from = lastPoint.current ?? point;
    context.strokeStyle = STROKE_COLOR;
    context.lineWidth = (canvas.width * brushPercent) / 100;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    lastPoint.current = point;
  };

  const startStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    canvas.setPointerCapture(event.pointerId);
    lastPoint.current = null;
    paintTo(canvas, canvasPoint(canvas, event));
  };

  const continueStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    paintTo(event.currentTarget, canvasPoint(event.currentTarget, event));
  };

  const endStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    lastPoint.current = null;
    const strokes = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height);
    setPainted(!!strokes && hasPaintedPixels(strokes.data));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    setPainted(false);
  };

  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await uploadMask(canvas, source.fileName));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The mask could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={saving ? undefined : onClose}>
      <ModalDialog sx={{ width: 'min(960px, 95vw)', maxHeight: '95vh' }} data-testid="image-mask-painter">
        <ModalClose disabled={saving} />
        <DialogTitle>Draw the area to change</DialogTitle>
        <DialogContent sx={{ gap: 1.5 }}>
          <Typography level="body-sm">
            Paint over the part of the image you want changed. Everything you leave unpainted is kept.
          </Typography>
          <Box sx={{ position: 'relative', alignSelf: 'center', maxWidth: '100%', lineHeight: 0 }}>
            {url ? (
              <>
                <img
                  src={url}
                  alt={source.fileName}
                  onLoad={event => sizeCanvasToImage(event.currentTarget)}
                  style={{ display: 'block', maxWidth: '100%', maxHeight: '60vh', userSelect: 'none' }}
                  draggable={false}
                  data-testid="image-mask-painter-source"
                />
                <canvas
                  ref={canvasRef}
                  onPointerDown={startStroke}
                  onPointerMove={continueStroke}
                  onPointerUp={endStroke}
                  onPointerCancel={endStroke}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    opacity: 0.55,
                    cursor: 'crosshair',
                    touchAction: 'none',
                  }}
                  data-testid="image-mask-painter-canvas"
                />
              </>
            ) : (
              <CircularProgress size="sm" />
            )}
          </Box>
          <FormControl>
            <FormLabel>Brush size</FormLabel>
            <Slider
              min={BRUSH_MIN}
              max={BRUSH_MAX}
              value={brushPercent}
              onChange={(_event, value) => {
                if (typeof value === 'number') setBrushPercent(value);
              }}
              slotProps={{ input: { 'data-testid': 'image-mask-painter-brush-slider' } }}
            />
          </FormControl>
          {error && (
            <Typography level="body-sm" color="danger" data-testid="image-mask-painter-error">
              {error}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => void save()}
            loading={saving}
            disabled={!painted}
            data-testid="image-mask-painter-save-btn"
          >
            Use this mask
          </Button>
          <Button
            variant="plain"
            color="neutral"
            onClick={clear}
            disabled={!painted || saving}
            data-testid="image-mask-painter-clear-btn"
          >
            Clear
          </Button>
          <Button
            variant="plain"
            color="neutral"
            onClick={onClose}
            disabled={saving}
            data-testid="image-mask-painter-cancel-btn"
          >
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default ImageMaskPainter;
