import { useShareDocument } from '@client/app/hooks/data/invites';
import { useUserRevokeSharing } from '@client/app/hooks/data/user';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { useUser } from '@client/app/contexts/UserContext';

import { InviteType, IUserShare, Permission, IFabFileDocument, ISessionDocument } from '@bike4mind/common';
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  ChipDelete,
  CircularProgress,
  Divider,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalClose,
  Sheet,
  Tab,
  TabList,
  Tabs,
  Textarea,
  Theme,
  Tooltip,
  Typography,
} from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import GroupIcon from '@mui/icons-material/Group';
import ShareIcon from '@mui/icons-material/Share';
import EmailIcon from '@mui/icons-material/Email';

import UsernameText from './UsernameText';
import { FormEvent, useEffect, useState } from 'react';
import { cloneDeep } from 'lodash';
import { toast } from 'sonner';
import { brandAlpha } from '../../utils/themes/colors';
import { api } from '@client/app/contexts/ApiContext';

// Helper to show bulk operation feedback with success/partial/failure states
const showBulkFeedback = (
  successCount: number,
  failedItems: string[],
  itemType: string,
  action: string
): 'success' | 'partial' | 'failure' => {
  const plural = successCount > 1 ? 's' : '';

  if (failedItems.length === 0) {
    toast.success(`Successfully ${action} ${successCount} ${itemType}${plural}`);
    return 'success';
  } else if (successCount > 0) {
    const failedPreview = failedItems.slice(0, 3).join(', ') + (failedItems.length > 3 ? '...' : '');
    toast.warning(
      `${action.charAt(0).toUpperCase() + action.slice(1)} ${successCount} ${itemType}${plural}, but ${failedItems.length} failed: ${failedPreview}`
    );
    return 'partial';
  } else {
    toast.error(`Failed to ${action.replace(/ed$/, '')} any ${itemType}s`);
    return 'failure';
  }
};

interface IProps {
  // Single item props
  id?: string;
  name?: string;
  type: InviteType;
  open: boolean;
  users?: IUserShare[];
  onClose: () => void;

  // Bulk sharing props
  files?: IFabFileDocument[];
  sessions?: ISessionDocument[];
}

const ShareDocumentModal = ({ id, onClose, type, open, name, users, files, sessions }: IProps) => {
  const [recipients, setRecipients] = useState<{ value: string[]; error?: string | null }>({ value: [] });
  const [currentInputValue, setCurrentInputValue] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [tabIndex, setTabIndex] = useState(1);
  const [generatedLink, setGeneratedLink] = useState('');
  const [completedShares, setCompletedShares] = useState<number>(0);
  const [sharedUsers, setSharedUsers] = useState<IUserShare[]>(users || []);
  const [emailMessage, setEmailMessage] = useState<string>('');
  const { copied, handleCopyToClipboard } = useCopyToClipboard();
  const { currentUser } = useUser();
  const confirm = useConfirmation();

  // Determine if this is bulk sharing
  const isBulkSharingFiles = Boolean(files && files.length > 0);
  const isBulkSharingSessions = Boolean(sessions && sessions.length > 0);
  const isBulkSharing = isBulkSharingFiles || isBulkSharingSessions;

  const itemCount = isBulkSharingFiles ? files!.length : isBulkSharingSessions ? sessions!.length : 1;
  const itemType = isBulkSharingFiles
    ? 'file'
    : isBulkSharingSessions
      ? 'notebook'
      : type === InviteType.Session
        ? 'notebook'
        : 'item';
  const displayName = isBulkSharing ? `${itemCount} ${itemType}${itemCount > 1 ? 's' : ''}` : name || itemType;

  const revokeUserSharing = useUserRevokeSharing({
    onSuccess: () => toast.success("Successfully revoked user's sharing permission"),
    onError: () => toast.error('Failed to revoke user sharing permission'),
  }).mutate;

  // Keep this in-case we revisit permission updating on sharing
  const [permissions] = useState<{ value: Permission[]; error?: string | null }>({
    value: [Permission.read, Permission.share],
    error: null,
  });

  const shareDocument = useShareDocument({
    onSuccess: () => {
      // Don't close the modal here; handleShareSubmit closes it after the toast is visible.
      // Bulk completion is handled in the loop; link generation in the useEffect below.
    },
    onSettled: () => {
      if (!isBulkSharing) {
        setLoading(false);
      }
    },
  });

  const handleShareSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setCompletedShares(0);

    const description: string | null =
      (e.target as HTMLFormElement)?.description?.value ||
      (isBulkSharing ? `Shared ${itemCount} ${itemType}${itemCount > 1 ? 's' : ''} with you` : null);

    let recipientValue = cloneDeep(recipients.value);
    let isInvalid = false;

    if (tabIndex === 0 || tabIndex === 2) {
      // Tab 0 = By Users, Tab 2 = Email
      // Include the current input value if it's not empty
      if (currentInputValue && currentInputValue.trim() !== '') {
        recipientValue = [...recipientValue, currentInputValue.trim()];
      }

      if (recipientValue.length === 0) {
        setRecipients({ ...recipients, error: 'Recipients is required' });
        isInvalid = true;
      } else if (
        tabIndex === 0 &&
        currentUser &&
        recipientValue.some(
          recipient =>
            // Check if user is trying to share to themselves via email, username, or ID
            recipient === currentUser.email || recipient === currentUser.username || recipient === currentUser.id
        )
      ) {
        // Prevent self-sharing and show error message (only for "By Users" tab)
        setRecipients({ ...recipients, error: 'You cannot share files to yourself' });
        isInvalid = true;
      } else {
        setRecipients({ ...recipients, error: null });
      }
    } else {
      // Empty recipients in case of link sharing (tab 1)
      recipientValue = [];
    }

    if (isInvalid) {
      setLoading(false);
      return;
    }

    try {
      if (isBulkSharing) {
        if (tabIndex === 2) {
          // Handle bulk email sending
          if (!isBulkSharingFiles) {
            toast.error('Email sharing is currently only supported for files');
            setLoading(false);
            return;
          }

          const fileIds = files!.map(f => f.id);

          try {
            const response = await api.post('/api/email/send', {
              type: 'files',
              fileIds,
              recipients: recipientValue,
              message: emailMessage,
            });

            if (response.data.success) {
              toast.success(response.data.message);
              setCurrentInputValue('');
              setRecipients({ value: [] });
              setEmailMessage('');
              onClose();
            } else {
              toast.error(response.data.message || 'Failed to send email');
            }
          } catch (error) {
            console.error('Email error:', error);
            toast.error('Failed to send email');
          }
          setLoading(false);
          return;
        } else if (tabIndex === 1) {
          // For bulk link generation, create individual invites and combine their IDs into one link
          const successResults: Array<{ link: string }> = [];
          const failedItems: string[] = [];
          const items = isBulkSharingFiles ? files! : sessions!;

          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const itemName = isBulkSharingFiles
              ? (item as IFabFileDocument).fileName
              : (item as ISessionDocument).name || 'Untitled';

            try {
              const result = await shareDocument.mutateAsync({
                description,
                recipients: recipientValue,
                id: item.id,
                type: isBulkSharingFiles ? InviteType.FabFile : InviteType.Session,
                permissions: permissions.value,
              });

              if (result?.link) {
                successResults.push(result);
              } else {
                failedItems.push(itemName);
              }
            } catch (error) {
              console.error(`Failed to generate link for ${itemName}:`, error);
              failedItems.push(itemName);
            }
            setCompletedShares(i + 1);
          }

          // Generate a single bulk link with all invite IDs from successful results
          if (successResults.length > 0) {
            const inviteIds = successResults.map(result => {
              // Extract invite ID from link (last part after /share/)
              const linkParts = result.link.split('/share/');
              return linkParts[linkParts.length - 1];
            });

            const baseUrl = successResults[0].link.split('/share/')[0];
            const bulkLink = `${baseUrl}/share/${inviteIds.join(',')}`;
            setGeneratedLink(bulkLink);
          }

          showBulkFeedback(successResults.length, failedItems, itemType, 'generated links for');
        } else {
          // Handle bulk sharing to users - process items sequentially to show accurate progress
          const successResults: Array<{ link?: string }> = [];
          const failedItems: string[] = [];
          const items = isBulkSharingFiles ? files! : sessions!;

          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const itemName = isBulkSharingFiles
              ? (item as IFabFileDocument).fileName
              : (item as ISessionDocument).name || 'Untitled';

            try {
              const result = await shareDocument.mutateAsync({
                description,
                recipients: recipientValue,
                id: item.id,
                type: isBulkSharingFiles ? InviteType.FabFile : InviteType.Session,
                permissions: permissions.value,
              });

              successResults.push(result);
            } catch (error) {
              console.error(`Failed to share ${itemName}:`, error);
              failedItems.push(itemName);
            }
            setCompletedShares(i + 1);
          }

          const result = showBulkFeedback(successResults.length, failedItems, itemType, 'shared');
          if (result === 'failure') {
            setLoading(false);
            return; // Don't close modal if all failed
          }

          // Close modal for "By Users" sharing (even on partial success)
          setCurrentInputValue('');
          setRecipients({ value: [] });
          onClose();
        }
      } else {
        // Handle single file/session sharing
        if (!id) {
          toast.error('Cannot share: No ID provided');
          setLoading(false);
          return;
        }

        if (tabIndex === 2) {
          // Handle single item email sending
          if (type !== InviteType.FabFile) {
            toast.error('Email sharing is currently only supported for files');
            setLoading(false);
            return;
          }

          try {
            const response = await api.post('/api/email/send', {
              type: 'files',
              fileIds: [id],
              recipients: recipientValue,
              message: emailMessage,
            });

            if (response.data.success) {
              toast.success(response.data.message);
              setCurrentInputValue('');
              setRecipients({ value: [] });
              setEmailMessage('');

              setTimeout(() => {
                onClose();
              }, 100);
            } else {
              toast.error(response.data.message || 'Failed to send email');
            }
          } catch (error) {
            console.error('Email error:', error);
            toast.error('Failed to send email');
          }
          setLoading(false);
          return;
        }

        await shareDocument.mutateAsync({
          description,
          recipients: recipientValue,
          id: id,
          type,
          permissions: permissions.value,
        });

        if (tabIndex === 0) {
          // Sharing by users
          toast.success(
            `Successfully shared ${displayName} to ${recipientValue.length} recipient${recipientValue.length > 1 ? 's' : ''}`
          );

          // Clear input and close modal after showing toast
          setCurrentInputValue('');
          setRecipients({ value: [] });

          // Delay closing to ensure toast is visible
          setTimeout(() => {
            onClose();
          }, 100);
        }
      }
    } catch (error) {
      // This catch handles single-item sharing failures only
      // Bulk sharing errors are handled within the loops above
      if (!isBulkSharing) {
        console.error('Error in sharing:', error);
        toast.error('Failed to share file');
      }
    } finally {
      if (isBulkSharing) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (tabIndex !== 1) return;
    // Only set individual link for single file sharing, not bulk sharing
    if (!isBulkSharing && shareDocument.data && shareDocument.data.link) {
      setGeneratedLink(shareDocument.data.link);
    }
  }, [tabIndex, shareDocument.data, isBulkSharing]);

  const labelSx = (theme: Theme) => ({
    color: theme.palette.text.primary,
    leadingTrim: 'both',
    textEdge: 'cap',
    fontSize: '14px',
    fontStyle: 'normal',
    fontWeight: '600',
  });

  const handleUserDelete = async (userId: string) => {
    confirm({
      title: `Revoke sharing for user`,
      description: 'Are you sure you want to revoke sharing for this user?',
      onOk: async () => {
        await revokeUserSharing({
          type: type as InviteType.FabFile | InviteType.Session,
          id: id!,
          userId,
        });
        setSharedUsers((prevUsers: IUserShare[]) => prevUsers.filter((u: IUserShare) => u.userId !== userId));
      },
      onCancel: () => {},
    });
  };

  // Generate file list display for bulk sharing
  const fileListDisplay = isBulkSharing
    ? (() => {
        if (isBulkSharingFiles && files) {
          const fileNames = files.map(f => f.fileName).join(', ');
          return fileNames.length > 100 ? `${fileNames.substring(0, 100)}...` : fileNames;
        } else if (isBulkSharingSessions && sessions) {
          const sessionNames = sessions.map(s => s.name).join(', ');
          return sessionNames.length > 100 ? `${sessionNames.substring(0, 100)}...` : sessionNames;
        }
        return '';
      })()
    : '';

  return (
    <Modal
      className="share-modal"
      open={open}
      onClose={onClose}
      sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}
    >
      <Sheet
        className="share-modal-content"
        sx={{
          width: '660px',
          boxShadow: 'lg',
          padding: '0px',
        }}
      >
        <ModalClose />
        <Box textAlign={'center'}>
          <Typography mt={'30px'} mb={'20px'} component={'h2'} level="h4">
            Share {type === InviteType.Session ? 'Notebook' : type} - {displayName}
          </Typography>
          {isBulkSharing && (
            <Typography level="body-sm" sx={{ mb: 2, px: 2, color: 'text.secondary' }}>
              {isBulkSharingSessions ? 'Notebooks' : 'Files'}: {fileListDisplay}
            </Typography>
          )}
        </Box>

        <Tabs
          className="share-modal-tabs"
          value={tabIndex}
          onChange={(_, newValue) => setTabIndex(newValue as number)}
          aria-label="Share Modal tab"
        >
          <TabList
            variant="plain"
            sx={{
              fontSize: 'small',
              padding: '1em 2em',
              borderBottom: `1px solid ${brandAlpha[600][20]}`,
              borderColor: 'border.light',
              boxShadow: 'unset',
              gap: '5px',
            }}
          >
            <Tooltip title={'By Users'}>
              <Tab
                className="share-modal-tab"
                sx={{
                  width: '33.33%',
                  height: '35px',
                  borderRadius: '10px',
                }}
                color="primary"
                variant={'soft'}
              >
                <GroupIcon /> By Users
              </Tab>
            </Tooltip>
            <Tooltip title={'By Link'}>
              <Tab
                sx={{
                  width: '33.33%',
                  borderRadius: '10px',
                }}
                color="primary"
                variant={'soft'}
              >
                <ShareIcon /> By Link
              </Tab>
            </Tooltip>
            <Tooltip title={'Via Email'}>
              <Tab
                sx={{
                  width: '33.33%',
                  borderRadius: '10px',
                }}
                color="primary"
                variant={'soft'}
              >
                <EmailIcon /> Email
              </Tab>
            </Tooltip>
          </TabList>

          <Box sx={{ padding: '2em' }}>
            <form onSubmit={handleShareSubmit}>
              <Box sx={{ display: 'grid', gap: '1em' }}>
                {tabIndex !== 2 && (
                  <FormControl id="description">
                    <FormLabel sx={labelSx} id="description-label" data-testid="share-modal-description-label">
                      Description (Optional)
                    </FormLabel>
                    <Textarea
                      className="share-modal-description"
                      minRows={4}
                      variant={'outlined'}
                      name={'description'}
                      placeholder={
                        isBulkSharing
                          ? `Description for others to understand what you are sharing (${itemCount} files)...`
                          : 'Description for others to view to understand what you are sharing...'
                      }
                    />
                  </FormControl>
                )}
                {(tabIndex === 0 || tabIndex === 2) && (
                  <FormControl id="recipients">
                    <FormLabel sx={labelSx} id="recipients-label">
                      {tabIndex === 2 ? 'Email Recipients' : 'Recipients'}
                    </FormLabel>
                    <Autocomplete
                      className="share-modal-recipients"
                      slotProps={{
                        wrapper: {
                          style: {
                            alignItems: 'flex-start',
                          },
                        },
                      }}
                      sx={{ width: '100%', '--Input-minHeight': '100px' }}
                      value={recipients.value}
                      onChange={(_, value) => {
                        // Filter out current user's email/username (only for "By Users" tab)
                        if (tabIndex === 0) {
                          const filteredValue = value.filter(
                            recipient =>
                              currentUser && recipient !== currentUser.email && recipient !== currentUser.username
                          );
                          if (filteredValue.length !== value.length) {
                            setRecipients({ value: filteredValue, error: 'You cannot share files to yourself' });
                          } else {
                            setRecipients({ value: filteredValue, error: null });
                          }
                        } else {
                          setRecipients({ value, error: null });
                        }
                      }}
                      inputValue={currentInputValue}
                      onInputChange={(_, newInputValue) => setCurrentInputValue(newInputValue)}
                      error={(recipients?.error ?? '').length > 0}
                      multiple
                      freeSolo
                      name={'recipients'}
                      placeholder={
                        tabIndex === 2
                          ? 'Enter email addresses - press Enter to add multiple'
                          : 'Enter email or username - press Enter to add multiple recipients'
                      }
                      options={[]}
                      disableClearable={true}
                    />
                    <FormHelperText>
                      <Typography level={'body-xs'} color={'danger'}>
                        {recipients?.error ?? ''}
                      </Typography>
                    </FormHelperText>
                  </FormControl>
                )}
                {tabIndex === 2 && (
                  <FormControl id="emailMessage">
                    <FormLabel sx={labelSx} id="emailMessage-label">
                      Personal Message (Optional)
                    </FormLabel>
                    <Textarea
                      className="share-modal-email-message"
                      minRows={3}
                      variant={'outlined'}
                      value={emailMessage}
                      onChange={e => setEmailMessage(e.target.value)}
                      placeholder="Add a personal message to include in the email..."
                    />
                  </FormControl>
                )}
              </Box>

              {isBulkSharing && completedShares > 0 && completedShares < itemCount && (
                <Box sx={{ mt: 2 }}>
                  <Typography level="body-sm" color="primary">
                    Progress: {completedShares}/{itemCount} files shared
                  </Typography>
                </Box>
              )}

              <Box mt={'15px'} display={'flex'}>
                {generatedLink ? (
                  <>
                    <Box flex={1} mr={'10px'}>
                      <Input className="share-modal-generated-link" variant={'outlined'} value={generatedLink} />
                    </Box>
                    <Box mr={'10px'}>
                      <IconButton
                        className="share-modal-copy-button"
                        variant={copied ? 'solid' : 'outlined'}
                        color={copied ? 'success' : 'neutral'}
                        onClick={() => handleCopyToClipboard(generatedLink)}
                      >
                        <ContentCopyIcon />
                      </IconButton>
                    </Box>
                  </>
                ) : (
                  <Box flex={1} />
                )}
                <Button
                  className="share-modal-submit-button"
                  data-testid="share-modal-submit-button"
                  disabled={loading}
                  type={'submit'}
                  sx={{ minWidth: '200px' }}
                  variant={'solid'}
                  color={'success'}
                >
                  {loading ? (
                    <CircularProgress className="share-modal-loading-indicator" />
                  ) : tabIndex === 0 ? (
                    'Share'
                  ) : tabIndex === 1 ? (
                    'Generate'
                  ) : (
                    'Send Email'
                  )}
                </Button>
              </Box>
            </form>
          </Box>
        </Tabs>
        {sharedUsers && sharedUsers.length > 0 && tabIndex === 0 && !isBulkSharing && (
          <Box>
            <Divider>
              <Chip
                variant="soft"
                size="md"
                sx={theme => ({
                  backgroundColor: theme.palette.notebooklist.focusedBackground,
                  width: '500px',
                })}
              >
                Shared To
              </Chip>
            </Divider>
            <Box
              sx={theme => ({
                minHeight: '1em',
                padding: '1em',
                margin: '1em',
                border: `1px solid ${theme.palette.shareModal.sharedUsersBorder}`,
                background: 'background.panel',
                borderRadius: '10px',
              })}
            >
              {sharedUsers.map((user, index) => (
                <UsernameText
                  key={index}
                  id={user.userId as string}
                  parent={props => (
                    <Chip
                      variant="soft"
                      size="md"
                      color="primary"
                      sx={theme => ({
                        backgroundColor: theme.palette.notebooklist.focusedBackground,
                        width: '500px',
                      })}
                      endDecorator={<ChipDelete onClick={() => handleUserDelete(user.userId as string)} />}
                      {...props}
                    />
                  )}
                  useEmail
                />
              ))}
            </Box>
          </Box>
        )}
      </Sheet>
    </Modal>
  );
};

export default ShareDocumentModal;
