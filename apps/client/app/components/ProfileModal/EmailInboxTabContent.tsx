import { useUser } from '@client/app/contexts/UserContext';
import {
  Box,
  Typography,
  Table,
  Sheet,
  CircularProgress,
  Chip,
  IconButton,
  Modal,
  ModalDialog,
  Stack,
  Tooltip,
} from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useState, useCallback } from 'react';
import VisibilityIcon from '@mui/icons-material/Visibility';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import DescriptionIcon from '@mui/icons-material/Description';
import CloseIcon from '@mui/icons-material/Close';
import { toast } from 'sonner';
import { useKnowledgeModal } from '@client/app/components/Knowledge/KnowledgeModal';

interface EmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  fabFileId?: string;
}

interface IngestedEmail {
  _id: string;
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  bodyMarkdown?: string;
  bodyFabFileId?: string;
  attachments?: EmailAttachment[];
  receivedAt: string;
  ingestedAt: string;
  platformEmailAddress?: string;
}

const EmailInboxTabContent = () => {
  const { currentUser } = useUser();
  const [selectedEmail, setSelectedEmail] = useState<IngestedEmail | null>(null);
  const { setSelectedFabFileId, setViewOnly, setOpen } = useKnowledgeModal();
  const queryClient = useQueryClient();

  const openFileDirectly = useCallback(
    (fabFileId?: string) => {
      if (!fabFileId) {
        console.warn('⚠️ No fabFileId provided for file opening');
        return;
      }
      setSelectedFabFileId(fabFileId);
      setViewOnly(false);
      setOpen(true);
    },
    [setSelectedFabFileId, setViewOnly, setOpen]
  );

  const deleteEmails = useMutation({
    mutationFn: async (emailIds: string[]) => {
      const { data } = await api.delete(`/api/users/${currentUser?.id}/ingested-emails`, {
        data: { emailIds },
      });
      return data as { deletedCount: number };
    },
    onSuccess: ({ deletedCount }) => {
      queryClient.invalidateQueries({ queryKey: ['ingested-emails', currentUser?.id] });
      toast.success(`Deleted ${deletedCount} email${deletedCount !== 1 ? 's' : ''}`);
    },
    onError: () => {
      toast.error('Failed to delete email');
    },
  });

  const {
    data: emails,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['ingested-emails', currentUser?.id],
    queryFn: async () => {
      console.log('📡 Fetching ingested emails for user:', currentUser?.id);
      if (!currentUser?.id) {
        console.log('⚠️ No current user ID, returning empty array');
        return [];
      }
      try {
        const url = `/api/users/${currentUser.id}/ingested-emails`;
        console.log('📡 API Request URL:', url);
        const response = await api.get(url);
        console.log('✅ API Response:', response.data);
        return response.data.emails as IngestedEmail[];
      } catch (err) {
        console.error('❌ Error fetching emails:', err);
        throw err;
      }
    },
    enabled: !!currentUser?.id,
  });

  console.log('📊 Query state:', { isLoading, emailCount: emails?.length, error });

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '300px' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!emails || emails.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', py: 8 }}>
        <Typography level="h4" sx={{ mb: 2 }}>
          No Emails Yet
        </Typography>
        <Typography level="body-md" sx={{ color: 'text.secondary' }}>
          Emails sent to your platform address will appear here.
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Typography level="h4" sx={{ mb: 2 }}>
        Email Inbox
      </Typography>
      <Typography level="body-sm" sx={{ mb: 3, color: 'text.secondary' }}>
        {emails.length} email{emails.length !== 1 ? 's' : ''} received
      </Typography>

      <Sheet
        variant="outlined"
        sx={{
          borderRadius: 'sm',
          overflow: 'auto',
          maxHeight: '600px',
        }}
      >
        <Table
          hoverRow
          size="sm"
          sx={{
            '& thead th': {
              position: 'sticky',
              top: 0,
              backgroundColor: 'background.surface',
              zIndex: 1,
            },
          }}
        >
          <thead>
            <tr>
              <th style={{ width: '20%' }}>From</th>
              <th style={{ width: '25%' }}>Subject</th>
              <th style={{ width: '25%' }}>Files</th>
              <th style={{ width: '15%' }}>Received</th>
              <th style={{ width: '8%' }}>Status</th>
              <th style={{ width: '7%' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {emails.map(email => {
              const attachmentsWithFabFiles = email.attachments?.filter(a => a.fabFileId) || [];
              const totalFiles = attachmentsWithFabFiles.length + (email.bodyFabFileId ? 1 : 0);

              return (
                <tr key={email._id}>
                  <td>
                    <Typography level="body-sm" sx={{ fontWeight: 'md' }}>
                      {email.from}
                    </Typography>
                  </td>
                  <td>
                    <Typography level="body-sm">{email.subject || '(No Subject)'}</Typography>
                  </td>
                  <td>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                      {email.bodyFabFileId && (
                        <Tooltip title="Email body (click to view)">
                          <Chip
                            size="sm"
                            variant="outlined"
                            color="primary"
                            startDecorator={<DescriptionIcon />}
                            onClick={() => openFileDirectly(email.bodyFabFileId)}
                            sx={{ cursor: 'pointer' }}
                            data-testid={`email-body-chip-${email._id}`}
                          >
                            Body
                          </Chip>
                        </Tooltip>
                      )}
                      {attachmentsWithFabFiles.map((attachment, idx) => (
                        <Tooltip key={idx} title={`${attachment.filename} (click to view)`}>
                          <Chip
                            size="sm"
                            variant="outlined"
                            color="neutral"
                            startDecorator={<AttachFileIcon />}
                            onClick={() => openFileDirectly(attachment.fabFileId)}
                            sx={{ cursor: 'pointer' }}
                            data-testid={`attachment-chip-${email._id}-${idx}`}
                          >
                            {attachment.filename.length > 20
                              ? `${attachment.filename.slice(0, 17)}...`
                              : attachment.filename}
                          </Chip>
                        </Tooltip>
                      ))}
                      {totalFiles === 0 && (
                        <Typography level="body-xs" sx={{ color: 'text.tertiary', fontStyle: 'italic' }}>
                          No files
                        </Typography>
                      )}
                    </Box>
                  </td>
                  <td>
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      {new Date(email.receivedAt).toLocaleString('en-US', {
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true,
                      })}
                    </Typography>
                  </td>
                  <td>
                    <Chip size="sm" color="success" variant="soft">
                      Ingested
                    </Chip>
                  </td>
                  <td>
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                      <Tooltip title="View email body">
                        <IconButton
                          size="sm"
                          variant="plain"
                          onClick={() => setSelectedEmail(email)}
                          data-testid={`view-email-btn-${email._id}`}
                        >
                          <VisibilityIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete email">
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="danger"
                          onClick={() => deleteEmails.mutate([email._id])}
                          disabled={deleteEmails.isPending}
                          data-testid={`delete-email-btn-${email._id}`}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Sheet>

      {/* Email Body Viewer Modal */}
      <Modal open={!!selectedEmail} onClose={() => setSelectedEmail(null)}>
        <ModalDialog
          sx={{
            maxWidth: '800px',
            width: '90%',
            maxHeight: '80vh',
            overflow: 'auto',
          }}
        >
          <Stack spacing={2}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <Stack spacing={1} sx={{ flex: 1 }}>
                <Typography level="h4">{selectedEmail?.subject || '(No Subject)'}</Typography>
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  <strong>From:</strong> {selectedEmail?.from}
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  <strong>To:</strong> {selectedEmail?.to.join(', ')}
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
                  <strong>Received:</strong>{' '}
                  {selectedEmail &&
                    new Date(selectedEmail.receivedAt).toLocaleString('en-US', {
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      hour12: true,
                    })}
                </Typography>
              </Stack>
              <IconButton
                variant="plain"
                color="neutral"
                onClick={() => setSelectedEmail(null)}
                data-testid="close-email-modal-btn"
              >
                <CloseIcon />
              </IconButton>
            </Box>

            <Box
              sx={{
                mt: 2,
                p: 2,
                backgroundColor: 'background.level1',
                borderRadius: 'sm',
                maxHeight: '400px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {selectedEmail?.bodyMarkdown ? (
                <Typography level="body-sm" sx={{ fontFamily: 'monospace' }}>
                  {selectedEmail.bodyMarkdown}
                </Typography>
              ) : selectedEmail?.bodyText ? (
                <Typography level="body-sm">{selectedEmail.bodyText}</Typography>
              ) : selectedEmail?.bodyHtml ? (
                <Box dangerouslySetInnerHTML={{ __html: selectedEmail.bodyHtml }} />
              ) : (
                <Typography level="body-sm" sx={{ fontStyle: 'italic', color: 'text.tertiary' }}>
                  No email body content available
                </Typography>
              )}
            </Box>

            {selectedEmail && (selectedEmail.bodyFabFileId || selectedEmail.attachments?.some(a => a.fabFileId)) && (
              <Box>
                <Typography level="body-sm" sx={{ mb: 1, fontWeight: 'md' }}>
                  Associated Files:
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                  {selectedEmail.bodyFabFileId && (
                    <Chip
                      size="sm"
                      variant="outlined"
                      color="primary"
                      startDecorator={<DescriptionIcon />}
                      onClick={() => {
                        openFileDirectly(selectedEmail.bodyFabFileId);
                        setSelectedEmail(null);
                      }}
                      sx={{ cursor: 'pointer' }}
                    >
                      Email Body (Markdown)
                    </Chip>
                  )}
                  {selectedEmail.attachments
                    ?.filter(a => a.fabFileId)
                    .map((attachment, idx) => (
                      <Chip
                        key={idx}
                        size="sm"
                        variant="outlined"
                        color="neutral"
                        startDecorator={<AttachFileIcon />}
                        onClick={() => {
                          openFileDirectly(attachment.fabFileId);
                          setSelectedEmail(null);
                        }}
                        sx={{ cursor: 'pointer' }}
                      >
                        {attachment.filename}
                      </Chip>
                    ))}
                </Box>
              </Box>
            )}
          </Stack>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

export default EmailInboxTabContent;
