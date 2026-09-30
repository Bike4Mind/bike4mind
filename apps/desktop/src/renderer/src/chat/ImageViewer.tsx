import Box from '@mui/joy/Box';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';

/**
 * One image at full size, over the thread.
 *
 * `src` is the SAME string its tile already rendered - the data URL readAttachment returned, or
 * a `b4m-media:` URL for a generated image. Nothing is refetched or re-encoded on the way here,
 * and nothing can be: img-src in index.html admits 'self', data: and b4m-media: and no more, so
 * a blob or object URL minted for this viewer would be blocked rather than shown.
 *
 * The dialog hugs the image rather than the other way round: ModalDialog brings a 300px minWidth
 * and stretches its children across, which would pad a tall image out sideways and scale a small
 * one UP to fill - so the min is cleared and the image centred on its own size. Only caps are set
 * on the image, never a width or a height.
 *
 * No close button: Modal already closes on Escape and on a backdrop click, and on a thumbnail-sized
 * image a corner button covers the very thing the viewer exists to show.
 */
export function ImageViewer({
  src,
  alt,
  open,
  onClose,
}: {
  src: string;
  alt: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        layout="center"
        variant="plain"
        sx={{
          p: 0,
          border: 'none',
          boxShadow: 'none',
          bgcolor: 'transparent',
          minWidth: 'unset',
          width: 'auto',
          maxWidth: 'none',
          alignItems: 'center',
        }}
        data-testid="attachment-viewer"
      >
        <Box
          component="img"
          src={src}
          alt={alt}
          sx={{
            display: 'block',
            maxWidth: '90vw',
            maxHeight: '90vh',
            objectFit: 'contain',
            borderRadius: 'sm',
          }}
          data-testid="attachment-viewer-image"
        />
      </ModalDialog>
    </Modal>
  );
}
