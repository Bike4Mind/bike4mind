import { useState } from 'react';
import {
  Box,
  Button,
  Table,
  Sheet,
  Typography,
  Modal,
  ModalDialog,
  IconButton,
  Chip,
  Stack,
  CircularProgress,
  DialogTitle,
  DialogContent,
  DialogActions,
  Tooltip,
} from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import LockIcon from '@mui/icons-material/Lock';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import {
  useEmailTemplates,
  useDeleteEmailTemplate,
  useCloneEmailTemplate,
  useEmailJobs,
} from '@client/app/hooks/data/emailMarketing';
import { EmailCategory, IEmailTemplateDocument } from '@bike4mind/common';
import EmailTemplateEditor from './EmailTemplateEditor';

const CATEGORY_LABELS: Record<EmailCategory, string> = {
  [EmailCategory.MARKETING]: 'Marketing',
  [EmailCategory.PRODUCT_UPDATE]: 'Product Update',
  [EmailCategory.NEWSLETTER]: 'Newsletter',
  [EmailCategory.ANNOUNCEMENT]: 'Announcement',
  [EmailCategory.TRANSACTIONAL]: 'Transactional',
};

export default function EmailTemplatesPanel() {
  const { data: templates, isLoading, refetch } = useEmailTemplates({ limit: 100 });
  const { data: jobs } = useEmailJobs({ limit: 1000 });
  const deleteMutation = useDeleteEmailTemplate();
  const cloneMutation = useCloneEmailTemplate();

  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Check if template is used by any job
  const isTemplateInUse = (templateId: string): boolean => {
    return jobs?.data?.some((job: any) => job.templateId === templateId) ?? false;
  };

  // Get jobs using a template
  const getJobsUsingTemplate = (templateId: string): string[] => {
    return jobs?.data?.filter((job: any) => job.templateId === templateId).map((job: any) => job.name) ?? [];
  };

  const handleOpenCreate = () => {
    setIsCreating(true);
    setEditingTemplateId(null);
  };

  const handleOpenEdit = (templateId: string) => {
    setEditingTemplateId(templateId);
    setIsCreating(false);
  };

  const handleBackToList = () => {
    setEditingTemplateId(null);
    setIsCreating(false);
  };

  const handleSaved = () => {
    refetch();
    handleBackToList();
  };

  const handleDelete = async () => {
    if (deleteConfirmId) {
      try {
        await deleteMutation.mutateAsync(deleteConfirmId);
        setDeleteConfirmId(null);
      } catch (error: any) {
        // Error will be shown by mutation
        console.error('Failed to delete template:', error);
      }
    }
  };

  const handleClone = async (templateId: string) => {
    try {
      const cloned = await cloneMutation.mutateAsync(templateId);
      // Open the cloned template for editing
      setEditingTemplateId(cloned.id);
    } catch (error: any) {
      console.error('Failed to clone template:', error);
    }
  };

  const existingSlugs = templates?.data?.map((t: IEmailTemplateDocument) => t.slug) || [];

  // Show editor view
  if (isCreating || editingTemplateId) {
    return (
      <EmailTemplateEditor
        templateId={editingTemplateId || undefined}
        existingSlugs={existingSlugs}
        onBack={handleBackToList}
        onSaved={handleSaved}
      />
    );
  }

  // Show list view - simple layout, scrolls with page
  return (
    <Box sx={{ p: 1 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
        <Typography level="title-lg">Email Templates</Typography>
        <Button startDecorator={<AddIcon />} onClick={handleOpenCreate} data-testid="new-template-btn">
          New Template
        </Button>
      </Box>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Sheet variant="outlined" sx={{ borderRadius: 'sm', overflow: 'auto' }}>
          <Table stickyHeader>
            <thead>
              <tr>
                <th style={{ width: '25%' }}>Name</th>
                <th style={{ width: '15%' }}>Category</th>
                <th style={{ width: '35%' }}>Subject</th>
                <th style={{ width: '10%' }}>Status</th>
                <th style={{ width: '15%' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates?.data?.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <Typography level="body-sm" sx={{ textAlign: 'center', py: 4 }}>
                      No templates yet. Create your first template to get started.
                    </Typography>
                  </td>
                </tr>
              )}
              {templates?.data?.map((template: IEmailTemplateDocument) => {
                const inUse = isTemplateInUse(template.id);
                const usingJobs = getJobsUsingTemplate(template.id);

                return (
                  <tr key={template.id}>
                    <td>
                      <Typography level="body-sm" fontWeight="md">
                        {template.name}
                      </Typography>
                      <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                        {template.slug}
                      </Typography>
                    </td>
                    <td>
                      <Chip size="sm" variant="soft">
                        {CATEGORY_LABELS[template.category] || template.category}
                      </Chip>
                    </td>
                    <td>
                      <Typography level="body-sm" noWrap sx={{ maxWidth: 300 }}>
                        {template.subject}
                      </Typography>
                    </td>
                    <td>
                      <Chip color={template.isActive ? 'success' : 'neutral'} size="sm" variant="soft">
                        {template.isActive ? 'Active' : 'Inactive'}
                      </Chip>
                    </td>
                    <td>
                      <Stack direction="row" spacing={1}>
                        <IconButton
                          size="sm"
                          variant="plain"
                          onClick={() => handleOpenEdit(template.id)}
                          data-testid={`edit-template-${template.id}`}
                        >
                          <EditIcon />
                        </IconButton>
                        <Tooltip title="Clone template">
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="primary"
                            onClick={() => handleClone(template.id)}
                            loading={cloneMutation.isPending}
                            data-testid={`clone-template-${template.id}`}
                          >
                            <ContentCopyIcon />
                          </IconButton>
                        </Tooltip>
                        {inUse ? (
                          <Tooltip
                            title={`Cannot delete: Used by ${usingJobs.length} campaign(s): ${usingJobs.slice(0, 3).join(', ')}${usingJobs.length > 3 ? '...' : ''}`}
                          >
                            <IconButton size="sm" variant="plain" color="neutral" disabled sx={{ opacity: 0.5 }}>
                              <LockIcon />
                            </IconButton>
                          </Tooltip>
                        ) : (
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="danger"
                            onClick={() => setDeleteConfirmId(template.id)}
                            data-testid={`delete-template-${template.id}`}
                          >
                            <DeleteIcon />
                          </IconButton>
                        )}
                      </Stack>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Sheet>
      )}

      {/* Delete Confirmation Modal */}
      <Modal open={!!deleteConfirmId} onClose={() => setDeleteConfirmId(null)}>
        <ModalDialog variant="outlined" role="alertdialog">
          <DialogTitle>Delete Template?</DialogTitle>
          <DialogContent>Are you sure you want to delete this template? This action cannot be undone.</DialogContent>
          <DialogActions>
            <Button variant="plain" color="neutral" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button variant="solid" color="danger" onClick={handleDelete} loading={deleteMutation.isPending}>
              Delete
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Box>
  );
}
