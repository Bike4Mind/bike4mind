import { FC, useState } from 'react';
import { Box, Button, Card, CircularProgress, IconButton, Modal, ModalClose, ModalDialog, Typography } from '@mui/joy';
import { Delete as DeleteIcon } from '@mui/icons-material';
import { toast } from 'sonner';
import { useImageTemplates, useDeleteImageTemplate } from '../../../hooks/data/imageTemplates';

interface ManageTemplatesModalProps {
  open: boolean;
  onClose: () => void;
}

/** Responsive grid of the caller's saved templates with delete. */
export const ManageTemplatesModal: FC<ManageTemplatesModalProps> = ({ open, onClose }) => {
  const { data: templates = [], isLoading } = useImageTemplates(open);
  const del = useDeleteImageTemplate();
  // Two-step delete: first click arms the card, second confirms. Avoids a
  // destructive single-click on a persisted resource with no undo.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    try {
      await del.mutateAsync(id);
      toast.success('Template deleted');
    } catch {
      toast.error('Could not delete template');
    } finally {
      setConfirmingId(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog data-testid="manage-templates-modal" sx={{ width: 'min(720px, 94vw)', maxHeight: '85vh' }}>
        <ModalClose data-testid="manage-templates-close-btn" />
        <Typography level="title-md" sx={{ mb: 1 }}>
          Manage image templates
        </Typography>

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
            <CircularProgress size="sm" />
          </Box>
        ) : templates.length === 0 ? (
          <Typography level="body-sm" sx={{ p: 2, opacity: 0.7 }} data-testid="manage-templates-empty">
            No templates yet. Save your current image settings to create one.
          </Typography>
        ) : (
          <Box
            sx={{
              display: 'grid',
              gap: 1.5,
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' },
              overflowY: 'auto',
            }}
          >
            {templates.map(t => (
              <Card key={t.id} variant="outlined" data-testid="manage-template-card" sx={{ gap: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
                  <Typography level="title-sm" noWrap>
                    {t.name}
                  </Typography>
                  {confirmingId === t.id ? (
                    <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
                      <Button
                        size="sm"
                        variant="solid"
                        color="danger"
                        loading={del.isPending}
                        data-testid="manage-template-confirm-delete-btn"
                        onClick={() => handleDelete(t.id)}
                      >
                        Delete
                      </Button>
                      <Button
                        size="sm"
                        variant="plain"
                        color="neutral"
                        data-testid="manage-template-cancel-delete-btn"
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </Button>
                    </Box>
                  ) : (
                    <IconButton
                      size="sm"
                      variant="plain"
                      color="danger"
                      data-testid="manage-template-delete-btn"
                      onClick={() => setConfirmingId(t.id)}
                    >
                      <DeleteIcon sx={{ fontSize: 18 }} />
                    </IconButton>
                  )}
                </Box>
                <Typography level="body-xs" sx={{ opacity: 0.7 }}>
                  {t.model}
                  {typeof t.usageCount === 'number' ? ` - used ${t.usageCount}x` : ''}
                </Typography>
                {t.description && (
                  <Typography level="body-xs" sx={{ opacity: 0.8 }}>
                    {t.description}
                  </Typography>
                )}
              </Card>
            ))}
          </Box>
        )}
      </ModalDialog>
    </Modal>
  );
};
