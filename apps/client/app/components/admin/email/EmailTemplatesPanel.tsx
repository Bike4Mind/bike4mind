import { useState } from 'react';
import { Button, Typography, IconButton, Chip, Stack, Tooltip } from '@mui/joy';
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
import {
  AdminDialog,
  AdminDialogFooter,
  DataTable,
  type DataColumn,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import EmailTemplateEditor from './EmailTemplateEditor';

const CATEGORY_LABELS: Record<EmailCategory, string> = {
  [EmailCategory.MARKETING]: 'Marketing',
  [EmailCategory.PRODUCT_UPDATE]: 'Product Update',
  [EmailCategory.NEWSLETTER]: 'Newsletter',
  [EmailCategory.ANNOUNCEMENT]: 'Announcement',
  [EmailCategory.TRANSACTIONAL]: 'Transactional',
};

const infoColumns: DataColumn<IEmailTemplateDocument>[] = [
  {
    id: 'name',
    label: 'Name',
    width: '25%',
    wrap: true,
    render: template => (
      <>
        <Typography level="body-sm" fontWeight="md">
          {template.name}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
          {template.slug}
        </Typography>
      </>
    ),
  },
  {
    id: 'category',
    label: 'Category',
    width: '15%',
    render: template => (
      <Chip size="sm" variant="soft">
        {CATEGORY_LABELS[template.category] || template.category}
      </Chip>
    ),
  },
  { id: 'subject', label: 'Subject', render: template => template.subject },
];

export default function EmailTemplatesPanel() {
  const { data: templates, isLoading, isError, refetch } = useEmailTemplates({ limit: 100 });
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

  // The in-use lock sits in Status rather than the hover-revealed row actions so it is always visible.
  const columns: DataColumn<IEmailTemplateDocument>[] = [
    ...infoColumns,
    {
      id: 'status',
      label: 'Status',
      width: '11rem',
      render: template => {
        const usingJobs = getJobsUsingTemplate(template.id);
        return (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Chip color={template.isActive ? 'success' : 'neutral'} size="sm" variant="soft">
              {template.isActive ? 'Active' : 'Inactive'}
            </Chip>
            {usingJobs.length > 0 && (
              <Tooltip
                title={`Cannot delete: Used by ${usingJobs.length} campaign(s): ${usingJobs.slice(0, 3).join(', ')}${usingJobs.length > 3 ? '...' : ''}`}
              >
                <Chip
                  size="sm"
                  variant="outlined"
                  color="neutral"
                  startDecorator={<LockIcon />}
                  data-testid={`template-in-use-${template.id}`}
                >
                  In use
                </Chip>
              </Tooltip>
            )}
          </Stack>
        );
      },
    },
  ];

  const renderRowActions = (template: IEmailTemplateDocument) => (
    <>
      <IconButton
        size="sm"
        variant="plain"
        onClick={() => handleOpenEdit(template.id)}
        aria-label="Edit template"
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
          aria-label="Clone template"
          data-testid={`clone-template-${template.id}`}
        >
          <ContentCopyIcon />
        </IconButton>
      </Tooltip>
      {!isTemplateInUse(template.id) && (
        <IconButton
          size="sm"
          variant="plain"
          color="danger"
          onClick={() => setDeleteConfirmId(template.id)}
          aria-label="Delete template"
          data-testid={`delete-template-${template.id}`}
        >
          <DeleteIcon />
        </IconButton>
      )}
    </>
  );

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
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="email-templates-panel">
      <Stack direction="row" justifyContent="flex-end" flexWrap="wrap" gap={1}>
        <Button size="sm" startDecorator={<AddIcon />} onClick={handleOpenCreate} data-testid="new-template-btn">
          New template
        </Button>
      </Stack>

      {isLoading ? (
        <LoadingState label="Loading templates" testId="email-templates-loading" />
      ) : isError && !templates ? (
        <ErrorState message="Could not load templates." onRetry={() => void refetch()} />
      ) : (
        <DataTable<IEmailTemplateDocument>
          label="Email templates"
          testId="email-templates-table"
          rows={templates?.data ?? []}
          columns={columns}
          getRowId={template => template.id}
          onRetry={() => void refetch()}
          empty={
            <EmptyState
              title="No templates yet"
              description="A template holds the subject and body that a campaign sends."
              action={
                <Button
                  size="sm"
                  variant="outlined"
                  startDecorator={<AddIcon />}
                  onClick={handleOpenCreate}
                  data-testid="email-templates-empty-create-btn"
                >
                  New template
                </Button>
              }
            />
          }
          rowActions={renderRowActions}
          actionsWidth="8rem"
          minWidth="50rem"
        />
      )}

      <AdminDialog
        open={!!deleteConfirmId}
        onClose={() => setDeleteConfirmId(null)}
        title="Delete template"
        role="alertdialog"
        data-testid="delete-template-dialog"
      >
        <Typography level="body-md">
          Are you sure you want to delete this template? This action cannot be undone.
        </Typography>
        <AdminDialogFooter>
          <Button
            variant="plain"
            color="neutral"
            onClick={() => setDeleteConfirmId(null)}
            data-testid="delete-template-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            variant="solid"
            color="danger"
            onClick={handleDelete}
            loading={deleteMutation.isPending}
            data-testid="delete-template-confirm-btn"
          >
            Delete
          </Button>
        </AdminDialogFooter>
      </AdminDialog>
    </Stack>
  );
}
