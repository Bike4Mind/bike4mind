import Box from '@mui/joy/Box';
import Modal from '@mui/joy/Modal';
import ModalClose from '@mui/joy/ModalClose';
import ModalDialog from '@mui/joy/ModalDialog';

/**
 * One image at full size, over the thread.
 *
 * `src` is the SAME string its tile already rendered - the data URL readAttachment returned, or
 * a `b4m-media:` URL for a generated image. Nothing is refetched or re-encoded on the way here,
 * and nothing can be: img-src in index.html admits 'self', data: and b4m-media: and no more, so
 * a blob or object URL minted for this viewer would be blocked rather than shown.
 *
 * No width or height is set on the image, only caps - an image smaller than the viewport keeps
 * its own size instead of being scaled up into mush.
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
        sx={{ p: 0, border: 'none', boxShadow: 'none', bgcolor: 'transparent' }}
        data-testid="attachment-viewer"
      >
        <ModalClose variant="soft" sx={{ m: 1 }} data-testid="attachment-viewer-close-btn" />
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
