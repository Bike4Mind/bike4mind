import React, { useState, useEffect } from 'react';
import { Typography, Button, Input, Stack, FormControl, FormLabel, Alert, Box, Grid } from '@mui/joy';
import { FieldTooltip } from '@client/app/components/help';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import { useUser } from '@client/app/contexts/UserContext';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useConfig } from '@client/app/hooks/data/settings';
import { toast } from 'sonner';
import SectionContainer from '../SectionContainer';

// Display-only placeholder domain shown when the deployment has not configured a platform
// email domain. Never used for validation.
const EXAMPLE_PLATFORM_DOMAIN = '@app.example.com';

interface EmailSettings {
  platformEmailAddress?: string;
  authorizedEmailAddresses?: string[];
}

const EmailIntegrationSection = () => {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();
  const { data: config } = useConfig();

  // Configured inbound-email domain. Empty until the deployment sets
  // PLATFORM_EMAIL_DOMAIN - in that case we show an example placeholder and skip the
  // suffix check rather than enforcing a brand domain that no longer exists.
  const platformDomain = config?.platformEmailDomain || '';
  const displayDomain = platformDomain || EXAMPLE_PLATFORM_DOMAIN;

  const [platformEmail, setPlatformEmail] = useState(currentUser?.platformEmailAddress || '');
  const [authorizedEmails, setAuthorizedEmails] = useState<string[]>(currentUser?.authorizedEmailAddresses || []);
  const [newEmail, setNewEmail] = useState('');

  // Sync local state with currentUser when it changes
  useEffect(() => {
    if (currentUser?.platformEmailAddress !== undefined) {
      setPlatformEmail(currentUser.platformEmailAddress || '');
    }
    if (currentUser?.authorizedEmailAddresses !== undefined) {
      setAuthorizedEmails(currentUser.authorizedEmailAddresses || []);
    }
  }, [currentUser?.platformEmailAddress, currentUser?.authorizedEmailAddresses]);

  const updateEmailSettings = useMutation({
    mutationFn: async (settings: EmailSettings) => {
      const response = await api.patch(`/api/users/${currentUser?.id}/email-settings`, settings);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
      toast.success('Email settings updated successfully!');
    },
    onError: error => {
      console.error('Failed to update email settings:', error);
      toast.error('Failed to update email settings');
    },
  });

  const handleAddEmail = () => {
    const email = newEmail.trim().toLowerCase();
    if (!email) {
      toast.error('Please enter an email address');
      return;
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error('Please enter a valid email address');
      return;
    }

    if (authorizedEmails.includes(email)) {
      toast.error('This email is already authorized');
      return;
    }

    setAuthorizedEmails([...authorizedEmails, email]);
    setNewEmail('');
  };

  const handleRemoveEmail = (emailToRemove: string) => {
    console.log('DELETE');
    setAuthorizedEmails(authorizedEmails.filter(email => email !== emailToRemove));
  };

  const handleSave = () => {
    // Validate platform email
    const cleanPlatformEmail = platformEmail.trim().toLowerCase();
    if (!cleanPlatformEmail) {
      toast.error('Please enter a platform email address');
      return;
    }

    if (platformDomain && !cleanPlatformEmail.endsWith(platformDomain)) {
      toast.error(`Platform email must end with ${platformDomain}`);
      return;
    }

    if (authorizedEmails.length === 0) {
      toast.error('Please add at least one authorized sender email');
      return;
    }

    updateEmailSettings.mutate({
      platformEmailAddress: cleanPlatformEmail,
      authorizedEmailAddresses: authorizedEmails,
    });
  };

  const isConfigured = Boolean(currentUser?.platformEmailAddress);

  return (
    <SectionContainer
      title={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <MailOutlineIcon sx={{ fontSize: '32px', color: 'primary.500' }} />
          <Typography level="h4" sx={{ fontSize: '16px' }}>
            Email-to-Platform Integration
          </Typography>
        </Box>
      }
      subtitle={
        isConfigured ? `Active: ${currentUser?.platformEmailAddress}` : 'Forward emails directly to your notebooks'
      }
    >
      <Stack spacing={3}>
        {/* Setup Instructions */}
        {!isConfigured && (
          <Alert
            color="primary"
            variant="soft"
            sx={theme => ({
              backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : undefined,
              alignSelf: 'flex-start',
              width: 'fit-content',
              p: 2,
            })}
          >
            <Box>
              <Typography level="body-sm" sx={{ color: 'text.primary', opacity: 0.5, mb: 1.5, fontWeight: 'bold' }}>
                Setup Instructions:
              </Typography>
              <Stack spacing={1}>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  1. Choose your unique platform email address (e.g., yourname{displayDomain})
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  2. Add the email addresses you&apos;ll send from (for security)
                </Typography>
                <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                  3. Start forwarding emails to your platform address
                </Typography>
              </Stack>
            </Box>
          </Alert>
        )}

        {/* Platform Email Input */}
        <Grid container spacing={2}>
          <Grid xs={12} md={6}>
            <FormControl>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <FormLabel
                  sx={{
                    userSelect: 'text',
                    color: 'text.primary',
                    opacity: 0.5,
                    m: 0,
                  }}
                >
                  Your Platform Email Address
                </FormLabel>
                <FieldTooltip
                  ariaLabel="Help: Your Platform Email Address"
                  content="This is the email address where you'll forward messages. It must be unique across all users."
                  placement="right"
                  iconSize={16}
                />
              </Box>
              <Input
                placeholder={`yourname${displayDomain}`}
                value={platformEmail}
                onChange={e => setPlatformEmail(e.target.value)}
                endDecorator={
                  platformDomain &&
                  platformEmail &&
                  !platformEmail.endsWith(platformDomain) && (
                    <Typography level="body-xs" sx={{ color: 'danger.500' }}>
                      Must end with {platformDomain}
                    </Typography>
                  )
                }
                sx={{
                  width: '100%',
                  overflow: 'hidden',
                  backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                  '& input': {
                    backgroundColor: 'transparent',
                    color: 'text.primary',
                    fontSize: '14px',
                    '&::placeholder': {
                      color: 'text.primary',
                      opacity: 0.5,
                      fontSize: '14px',
                    },
                  },
                }}
              />
              <Typography level="body-xs" sx={{ mt: 0.5, color: 'primary.500' }}>
                This must be unique{platformDomain ? ` and end with ${platformDomain}` : ''}
              </Typography>
            </FormControl>
          </Grid>
        </Grid>

        {/* Authorized Senders */}
        <FormControl>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <FormLabel
              sx={{
                userSelect: 'text',
                color: 'text.primary',
                opacity: 0.5,
                m: 0,
              }}
            >
              Authorized Sender Emails
            </FormLabel>
            <FieldTooltip
              ariaLabel="Help: Authorized Sender Emails"
              content="Only emails from these addresses will be accepted. All others will be rejected."
              placement="right"
              iconSize={16}
            />
          </Box>

          <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
            <Input
              placeholder="sender@example.com"
              value={newEmail}
              onChange={e => setNewEmail(e.target.value)}
              onKeyPress={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddEmail();
                }
              }}
              sx={{
                flex: 1,
                backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
                '& input': {
                  backgroundColor: 'transparent',
                  color: 'text.primary',
                  fontSize: '14px',
                  '&::placeholder': {
                    color: 'text.primary',
                    opacity: 0.5,
                    fontSize: '14px',
                  },
                },
              }}
            />
            <Button
              startDecorator={<AddIcon />}
              onClick={handleAddEmail}
              variant="outlined"
              color="primary"
              sx={{ flexShrink: 0 }}
            >
              Add
            </Button>
          </Box>

          {authorizedEmails.length > 0 && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {authorizedEmails.map(email => (
                <Box
                  key={email}
                  data-testid={`authorized-email-${email}`}
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                    px: 1.5,
                    py: 0.5,
                    borderRadius: 'sm',
                    backgroundColor: 'primary.softBg',
                    color: 'primary.softColor',
                    fontSize: '14px',
                  }}
                >
                  <Typography level="body-sm">{email}</Typography>
                  <CloseIcon
                    onClick={() => handleRemoveEmail(email)}
                    sx={{
                      fontSize: '18px',
                      cursor: 'pointer',
                      opacity: 0.7,
                      transition: 'opacity 0.2s',
                      '&:hover': {
                        opacity: 1,
                      },
                    }}
                    data-testid={`remove-email-${email}`}
                  />
                </Box>
              ))}
            </Box>
          )}

          {authorizedEmails.length === 0 && (
            <Typography level="body-sm" sx={{ color: 'text.primary', opacity: 0.5, fontStyle: 'italic' }}>
              No authorized senders yet. Add at least one email address.
            </Typography>
          )}
        </FormControl>

        {/* Usage Instructions */}
        <Alert
          color="primary"
          variant="soft"
          sx={theme => ({
            backgroundColor: theme.palette.mode === 'light' ? '#F7F9FB' : undefined,
            alignSelf: 'flex-start',
            width: 'fit-content',
            p: 2,
          })}
        >
          <Box>
            <Typography level="body-sm" sx={{ color: 'text.primary', opacity: 0.5, mb: 1.5, fontWeight: 'bold' }}>
              How it works:
            </Typography>
            <Stack spacing={1}>
              <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                • Send emails from your authorized address to your platform email
              </Typography>
              <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                • Emails will be parsed and stored in your account
              </Typography>
              <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                • AI analysis will extract entities, tags, and summaries
              </Typography>
              <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                • Attachments and links will be automatically processed
              </Typography>
              <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                • Emails from unauthorized senders will be rejected
              </Typography>
            </Stack>
          </Box>
        </Alert>

        {/* Save Button */}
        <Button
          onClick={handleSave}
          loading={updateEmailSettings.isPending}
          disabled={!platformEmail || authorizedEmails.length === 0}
          sx={{ alignSelf: 'flex-start' }}
          data-testid="save-email-settings-btn"
        >
          Save Email Settings
        </Button>
      </Stack>
    </SectionContainer>
  );
};

export default EmailIntegrationSection;
