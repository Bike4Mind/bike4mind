import React from 'react';
import { Modal, ModalDialog, ModalClose, Typography, Box, Sheet, Chip, CircularProgress } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { EmailSendStatus } from '@bike4mind/common';

interface EmailAttemptDetails {
  id: string;
  recipientEmail: string;
  recipientType: 'user' | 'subscriber' | 'direct';
  status: EmailSendStatus;
  sentAt?: Date;
  openedAt?: Date;
  clickedAt?: Date;
  isTestEmail?: boolean;
  originalRecipient?: string;
  renderedSubject?: string;
  renderedHtml?: string;
  errorMessage?: string;
}

interface EmailPreviewModalProps {
  open: boolean;
  onClose: () => void;
  attemptId: string | null;
}

const getStatusColor = (status: EmailSendStatus) => {
  switch (status) {
    case EmailSendStatus.SENT:
    case EmailSendStatus.DELIVERED:
    case EmailSendStatus.OPENED:
    case EmailSendStatus.CLICKED:
      return 'success';
    case EmailSendStatus.PENDING:
      return 'warning';
    case EmailSendStatus.PROCESSING:
      return 'primary';
    case EmailSendStatus.FAILED:
    case EmailSendStatus.BOUNCED:
      return 'danger';
    case EmailSendStatus.CANCELLED:
      return 'neutral';
    default:
      return 'neutral';
  }
};

export default function EmailPreviewModal({ open, onClose, attemptId }: EmailPreviewModalProps) {
  const { data: attempt, isLoading } = useQuery<EmailAttemptDetails>({
    queryKey: ['email-attempt-preview', attemptId],
    queryFn: async () => {
      if (!attemptId) throw new Error('No attempt ID');
      const response = await api.get(`/api/admin/email/attempts/${attemptId}`);
      return response.data;
    },
    enabled: !!attemptId && open,
  });

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        sx={{
          width: '90vw',
          maxWidth: 1000,
          height: '90vh',
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <ModalClose />
        <Typography level="title-lg">Email Preview</Typography>

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress />
          </Box>
        ) : attempt ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'auto', flex: 1, minHeight: 0 }}>
            {/* Email Details */}
            <Sheet variant="soft" sx={{ p: 2, borderRadius: 'md' }}>
              <Typography level="title-sm" sx={{ mb: 1 }}>
                Email Details
              </Typography>

              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 1 }}>
                <Typography level="body-sm">Status:</Typography>
                <Chip color={getStatusColor(attempt.status)} size="sm">
                  {attempt.status?.toUpperCase() ?? 'UNKNOWN'}
                </Chip>
                {attempt.isTestEmail && (
                  <Chip color="warning" size="sm">
                    TEST
                  </Chip>
                )}
              </Box>

              <Box sx={{ mb: 1 }}>
                <Typography level="body-sm">Recipient:</Typography>
                <Typography level="body-md" fontWeight="md">
                  {attempt.recipientEmail || 'Unknown'}
                </Typography>
                {attempt.isTestEmail && attempt.originalRecipient && (
                  <Typography level="body-xs" color="warning">
                    Original recipient: {attempt.originalRecipient}
                  </Typography>
                )}
              </Box>

              {attempt.sentAt && (
                <Box sx={{ mb: 1 }}>
                  <Typography level="body-sm">Time:</Typography>
                  <Typography level="body-md">{new Date(attempt.sentAt).toLocaleString()}</Typography>
                </Box>
              )}

              {attempt.renderedSubject && (
                <Box>
                  <Typography level="body-sm">Subject:</Typography>
                  <Typography level="body-md">{attempt.renderedSubject}</Typography>
                </Box>
              )}

              {attempt.errorMessage && (
                <Box sx={{ mt: 1 }}>
                  <Typography level="body-sm" color="danger">
                    Error:
                  </Typography>
                  <Typography level="body-md" color="danger">
                    {attempt.errorMessage}
                  </Typography>
                </Box>
              )}
            </Sheet>

            {/* Email Content */}
            {attempt.renderedHtml && (
              <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <Typography level="title-sm" sx={{ mb: 1 }}>
                  Email Content
                </Typography>
                <Box
                  sx={{
                    border: '1px solid',
                    borderColor: 'neutral.outlinedBorder',
                    borderRadius: 'md',
                    overflow: 'hidden',
                    bgcolor: 'white',
                    flex: 1,
                    minHeight: 300,
                  }}
                >
                  <iframe
                    srcDoc={attempt.renderedHtml}
                    style={{
                      width: '100%',
                      height: '100%',
                      border: 'none',
                    }}
                    title="Email Preview"
                  />
                </Box>
              </Box>
            )}
          </Box>
        ) : (
          <Box sx={{ p: 4, textAlign: 'center' }}>
            <Typography level="body-lg">Failed to load email details</Typography>
          </Box>
        )}
      </ModalDialog>
    </Modal>
  );
}
