import { useState } from 'react';
import Button from '@mui/joy/Button';
import DialogActions from '@mui/joy/DialogActions';
import DialogTitle from '@mui/joy/DialogTitle';
import Input from '@mui/joy/Input';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import { normalizeSectionName, SIDEBAR_SECTION_NAME_MAX_LENGTH } from '@shared/sidebarSections';

/** What the dialog is open for: a new section (optionally taking a session with it), or a rename. */
export type SectionNameRequest =
  { kind: 'create'; sessionId?: string } | { kind: 'rename'; sectionId: string; currentName: string };

/** Mounted only while open, so each opening starts from the request's own name. */
export function SectionNameDialog({
  request,
  onSubmit,
  onClose,
}: {
  request: SectionNameRequest;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const initialName = request.kind === 'rename' ? request.currentName : '';
  const [draft, setDraft] = useState(initialName);
  const name = normalizeSectionName(draft);
  const canSubmit = name.length > 0 && name !== initialName;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(name);
    onClose();
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog size="sm" sx={{ width: 320 }} data-testid="section-name-dialog">
        <DialogTitle>{request.kind === 'rename' ? 'Rename section' : 'New section'}</DialogTitle>
        <form
          onSubmit={event => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            autoFocus
            size="sm"
            value={draft}
            placeholder="Section name"
            onChange={event => setDraft(event.target.value)}
            // Kept away from SessionList's window-level Cmd shortcuts, the way the rename input is.
            // The stop also hides Escape from the Modal's own handler, so Escape closes here.
            onKeyDown={event => {
              event.stopPropagation();
              if (event.key === 'Escape') onClose();
            }}
            slotProps={{
              input: {
                maxLength: SIDEBAR_SECTION_NAME_MAX_LENGTH,
                'aria-label': 'Section name',
                'data-testid': 'section-name-input',
              },
            }}
          />
          <DialogActions sx={{ pt: 1.5 }}>
            <Button type="submit" size="sm" disabled={!canSubmit} data-testid="section-name-submit-btn">
              {request.kind === 'rename' ? 'Rename' : 'Create'}
            </Button>
            <Button size="sm" variant="plain" color="neutral" onClick={onClose} data-testid="section-name-cancel-btn">
              Cancel
            </Button>
          </DialogActions>
        </form>
      </ModalDialog>
    </Modal>
  );
}
