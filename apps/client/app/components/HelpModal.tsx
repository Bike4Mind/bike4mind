import React, { useState } from 'react';
import Link from 'next/link';

import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { toast } from 'sonner';

import {
  DialogContent,
  Button,
  Modal,
  ModalDialog,
  Typography,
  Textarea,
  Tooltip,
  Stack,
  IconButton,
  Box,
} from '@mui/joy';
import { createFeedbackOnServer } from '@client/app/utils/feedbackAPICalls';
import { FeedbackStatus } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import CloseIcon from '@mui/icons-material/Close';
import SettingsIcon from '@mui/icons-material/Settings';

import { useTheme } from '@mui/joy/styles';
import { useLogEvent } from '../hooks/data/analytics';
import { FeedbackEvents } from '@bike4mind/common';
import useGetLogo from '../hooks/useGetLogo';
import { APP_NAME } from '@client/config/general';

// Internal discriminant only (never displayed); the displayed brand is APP_NAME.
enum ProductType {
  Bike4Mind = 'default',
}

export const HelpModal: React.FC = () => {
  const currentUser = useUser(s => s.currentUser);
  const userId = currentUser?.id;
  const logEvent = useLogEvent();
  const { settings, updatePreferences } = useUserSettings();
  const [feedbackContent, setFeedbackContent] = useState<string>('');
  const theme = useTheme();
  const [productType] = useState<ProductType>(ProductType.Bike4Mind);
  const [productTitle] = useState<string>(APP_NAME);
  const logoUrl = useGetLogo();

  // Function that matches the signature expected by the `onClose` prop of Modal
  const handleClose = (
    event: {}, // unused; accepted to match the onClose signature
    reason: 'backdropClick' | 'escapeKeyDown' | 'closeClick'
  ) => {
    if (reason && reason !== 'backdropClick' && reason !== 'escapeKeyDown') {
      return;
    }
    toggleShowHelp();
  };

  const toggleShowHelp = (callback?: () => void) => {
    const showHelp = !settings.showHelp;
    if (showHelp && callback) {
      callback();
    }
    updatePreferences({ showHelp });
  };

  const toggleSettingsMenu = () => updatePreferences({ showHelp: false });

  const handleLinkClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    toggleShowHelp();
    const href = event.currentTarget.getAttribute('href');
    if (href) {
      window.location.href = href;
    }
  };

  const handleSubmitFeedback = async () => {
    try {
      if (!feedbackContent.trim()) {
        console.error('Feedback content is empty');
        return;
      }
      toast.success('Thank you! Your feedback has been submitted.');
      console.log('Submitting feedback:', currentUser?.email);

      toggleShowHelp();

      const feedbackCreated = await createFeedbackOnServer({
        userId: userId,
        username: currentUser?.username ?? 'Unknown',
        userEmail: currentUser?.email ?? 'Unknown',
        tags: ['feedback', 'cs'],
        content: feedbackContent,
        status: FeedbackStatus.New,
      });

      logEvent.mutate({
        type: FeedbackEvents.FEEDBACK_SENT,
        metadata: { id: feedbackCreated.id, content: feedbackCreated.content },
      });

      setFeedbackContent('');
    } catch (error) {
      console.error('Failed to submit feedback:', error);
    }
  };
  if (!settings.showHelp) return null;

  const renderContent = () => {
    switch (productType) {
      case ProductType.Bike4Mind:
        return (
          <>
            Beta users, please enjoy experimenting{productTitle ? ` with ${productTitle}` : ''}!
            <ul>
              <li>Q&A with the OpenAI GPT 3.5 and 4 models</li>
              <li>Try the voice to text and dictate your prompts</li>
              <li>
                Upload new <Link href="/knowledge" onClick={handleLinkClick}></Link> - Add your own PDF, TXT, CSV, and
                JSON data sources.
              </li>
              <li>
                Upload your files - See{' '}
                <Link href="/knowledge" target="_blank" rel="noopener noreferrer" onClick={handleLinkClick}>
                  Knowledge
                </Link>{' '}
                for more.
              </li>
              <li>Experiment with all of the LLM settings such as temperature, presence and frequency penalties, </li>
            </ul>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div style={{ marginRight: '10px' }}>For a deep dive, read the</div>
              <Button variant="outlined">
                <Link href="/guide" target="_blank" rel="noopener noreferrer" onClick={handleLinkClick}>
                  Guide
                </Link>
              </Button>
            </div>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <Modal open={settings.showHelp} onClose={handleClose}>
      <ModalDialog
        sx={theme => ({
          width: '90vh',
          color: theme.palette.feedback,
          [theme.breakpoints.down('lg')]: {
            width: '100vw',
          },
        })}
      >
        <DialogContent>
          <Stack display="flex" direction="row" alignItems="center" spacing={2}>
            {}
            <img src={logoUrl} alt={`${theme.branding.name} logo`} height={40} />

            <Typography level="h4" sx={{ flexGrow: 1, mb: '1em' }}>
              Welcome{productTitle ? ` to ${productTitle}` : ''}!
            </Typography>
            <Stack direction="row" sx={{ mb: '3em' }}>
              <Tooltip title="Settings">
                <IconButton
                  variant="outlined"
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    width: '0.5rem',
                    height: '0.5rem',
                    '& .MuiSvgIcon-root': {
                      fontSize: '1rem',
                    },
                  }}
                  onClick={() => toggleSettingsMenu()}
                >
                  <SettingsIcon />
                </IconButton>
              </Tooltip>
              <IconButton
                variant="outlined"
                sx={{
                  display: 'flex',
                  ml: '10px',
                  alignItems: 'center',
                  width: '0.5rem',
                  height: '0.5rem',
                  '& .MuiSvgIcon-root': {
                    fontSize: '1rem',
                  },
                }}
                onClick={() => toggleShowHelp()}
              >
                <CloseIcon />
              </IconButton>
            </Stack>
          </Stack>
          {renderContent()}
        </DialogContent>

        <Typography level="body-sm" mt="20px">
          Bug Reports, Questions and Feedback:
        </Typography>

        <Box display="flex" flexDirection="column" alignItems="flex-end">
          <Textarea
            minRows={8}
            value={feedbackContent}
            onChange={e => setFeedbackContent(e.target.value)}
            sx={theme => ({ width: '100%', mt: 1, color: theme.palette.feedback.border })}
          />
          <Button
            sx={{
              mt: 2,
              backgroundColor: 'green',
              color: 'white',
              '&:hover': {
                backgroundColor: 'darkgreen',
              },
            }}
            onClick={handleSubmitFeedback}
          >
            Send Feedback
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default HelpModal;
