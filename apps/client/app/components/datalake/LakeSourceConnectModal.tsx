import { DialogTitle, Modal, ModalClose, ModalDialog } from '@mui/joy';
import {
  getLakeSource,
  type LakeSourceKind,
  type LakeSourcePanelLake,
  type LakeSourcePanelProps,
} from '@client/app/components/datalake/lakeSources';

type LakeSourceConnectModalProps = {
  lake: LakeSourcePanelLake;
  /** The source whose connect panel to show; null keeps the modal closed. */
  kind: LakeSourceKind | null;
  onClose: () => void;
  /** Forwarded to the panel, so the caller can handle a started chat itself. */
  onChatStarted?: LakeSourcePanelProps['onChatStarted'];
};

/** One source's connect panel for an existing lake, opened straight from a "Connect a source" pick. */
export default function LakeSourceConnectModal({ lake, kind, onClose, onChatStarted }: LakeSourceConnectModalProps) {
  const source = kind ? getLakeSource(kind) : null;

  return (
    <Modal open={!!source} onClose={onClose}>
      <ModalDialog data-testid="lake-source-connect-modal" sx={{ maxWidth: 420 }}>
        <ModalClose />
        {source && (
          <>
            <DialogTitle>Connect {source.label}</DialogTitle>
            <source.Panel lake={lake} onChatStarted={onChatStarted} />
          </>
        )}
      </ModalDialog>
    </Modal>
  );
}
