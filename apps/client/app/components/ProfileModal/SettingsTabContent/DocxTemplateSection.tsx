import { useUser } from '@client/app/contexts/UserContext';
import { api } from '@client/app/contexts/ApiContext';
import { Box, Grid, Typography, Button, CircularProgress } from '@mui/joy';
import { useRef } from 'react';
import { toast } from 'sonner';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import { cardSurfaceSx } from '@client/app/components/ProfileModal/settingsStyles';
import DescriptionIcon from '@mui/icons-material/Description';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { VALID_DOCX_MIME_TYPES, MAX_DOCX_TEMPLATE_SIZE } from '@server/services/docxTemplateService';

interface TemplateInfo {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

interface TemplateResponse {
  template: TemplateInfo | null;
}

const ACCEPTED_FILE_TYPES = '.docx,.dotx';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const DocxTemplateSection = () => {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const userId = currentUser?.id;

  const { data: templateData, isLoading: isLoadingTemplate } = useQuery<TemplateResponse>({
    queryKey: ['docxTemplate', userId],
    queryFn: async () => {
      if (!userId) throw new Error('User not logged in');
      const response = await api.get(`/api/users/${userId}/docx-template`);
      return response.data;
    },
    enabled: !!userId,
  });

  // Mutation to upload and set template (combined 3-step flow)
  const uploadTemplateMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!userId) throw new Error('User not logged in');

      // Step 1: Get presigned URL for upload
      const formData = new FormData();
      formData.append('fileName', file.name);
      formData.append('fileSize', file.size.toString());
      formData.append('mimeType', file.type);

      const presignedResponse = await api.post('/api/app-files/generate-presigned-url', formData);
      const { presignedUrl, fileId } = presignedResponse.data;

      // Step 2: Upload file to S3
      await fetch(presignedUrl, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type,
        },
      });

      // Step 3: Set as template
      const response = await api.post(`/api/users/${userId}/docx-template`, { fileId });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['docxTemplate', userId] });
      toast.success('DOCX export template set successfully');
    },
    onError: (error: { response?: { data?: { error?: string } }; message?: string }) => {
      const errorMessage = error.response?.data?.error || error.message || 'Failed to upload template';
      toast.error(errorMessage);
    },
  });

  // Mutation to remove template
  const removeTemplateMutation = useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error('User not logged in');
      const response = await api.delete(`/api/users/${userId}/docx-template`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['docxTemplate', userId] });
      toast.success('DOCX export template removed');
    },
    onError: (error: { response?: { data?: { error?: string } }; message?: string }) => {
      const errorMessage = error.response?.data?.error || error.message || 'Failed to remove template';
      toast.error(errorMessage);
    },
  });

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    // Validate file size
    if (file.size > MAX_DOCX_TEMPLATE_SIZE) {
      toast.error('File is too large. Maximum size is 10MB.');
      return;
    }

    // Validate file type using shared constant
    if (!(VALID_DOCX_MIME_TYPES as readonly string[]).includes(file.type)) {
      toast.error('Invalid file type. Please upload a .docx or .dotx file.');
      return;
    }

    uploadTemplateMutation.mutate(file);
  };

  const handleRemoveTemplate = () => {
    removeTemplateMutation.mutate();
  };

  const template = templateData?.template;
  const isLoading = isLoadingTemplate || uploadTemplateMutation.isPending || removeTemplateMutation.isPending;

  return (
    <SectionContainer title="Document Export" subtitle="Customize the styling of exported Word documents">
      <Grid container spacing={2}>
        <Grid xs={12} md={8}>
          <Box
            sx={theme => ({
              ...cardSurfaceSx(theme),
              display: 'flex',
              alignItems: 'flex-start',
              gap: '16px',
              height: '100%',
            })}
          >
            <DescriptionIcon sx={{ fontSize: '24px', color: 'primary.500', mt: 0.5 }} />

            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography level="title-md" sx={{ fontSize: '16px', fontWeight: 500, mb: 1 }}>
                DOCX Export Template
              </Typography>

              <Typography level="body-sm" sx={{ mb: 2, color: 'text.secondary' }}>
                Upload a Word document (.docx or .dotx) to use as a template for your exports. The template&apos;s
                styling will be applied to exported conversations and quest plans.
              </Typography>

              {/* Current template info */}
              {template && (
                <Box
                  sx={{
                    mb: 2,
                    p: 1.5,
                    backgroundColor: 'background.level1',
                    borderRadius: 'sm',
                    border: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  <Typography level="body-sm" sx={{ fontWeight: 500 }}>
                    Current Template:
                  </Typography>
                  <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                    {template.fileName} ({formatFileSize(template.fileSize)})
                  </Typography>
                </Box>
              )}

              {/* Action buttons */}
              <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button
                  component="label"
                  variant="outlined"
                  color="primary"
                  startDecorator={
                    uploadTemplateMutation.isPending ? <CircularProgress size="sm" /> : <UploadFileIcon />
                  }
                  disabled={isLoading}
                  sx={{ minWidth: '140px' }}
                >
                  {template ? 'Replace Template' : 'Upload Template'}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPTED_FILE_TYPES}
                    hidden
                    onChange={handleFileSelect}
                  />
                </Button>

                {template && (
                  <Button
                    variant="outlined"
                    color="danger"
                    startDecorator={<DeleteOutlineIcon />}
                    onClick={handleRemoveTemplate}
                    disabled={isLoading}
                  >
                    Remove
                  </Button>
                )}
              </Box>

              {/* Info note */}
              <Typography
                level="body-xs"
                sx={{
                  color: 'text.tertiary',
                  mt: 2,
                  p: 1,
                  backgroundColor: 'background.level1',
                  borderRadius: 'sm',
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <strong>Note:</strong> Template styling will be applied to new exports. Supported file types: .docx,
                .dotx (max 10MB).
              </Typography>
            </Box>
          </Box>
        </Grid>
      </Grid>
    </SectionContainer>
  );
};

export default DocxTemplateSection;
