import { DialogTitle, Modal, ModalClose, ModalDialog } from '@mui/joy';
import { getLakeSource, type LakeSourceKind } from '@client/app/components/datalake/lakeSources';

type LakeSourceConnectModalProps = {
  lake: { id: string };
  /** The source whose connect panel to show; null keeps the modal closed. */
  kind: LakeSourceKind | null;
  onClose: () => void;
};

/** One source's connect panel for an existing lake, opened straight from a "Connect a source" pick. */
export default function LakeSourceConnectModal({ lake, kind, onClose }: LakeSourceConnectModalProps) {
  const source = kind ? getLakeSource(kind) : null;

  return (
    <Modal open={!!source} onClose={onClose}>
      <ModalDialog data-testid="lake-source-connect-modal" sx={{ maxWidth: 420 }}>
        <ModalClose />
        {source && (
          <>
            <DialogTitle>Connect {source.label}</DialogTitle>
            <source.Panel lake={lake} />
          </>
        )}
      </ModalDialog>
    </Modal>
  );
}
