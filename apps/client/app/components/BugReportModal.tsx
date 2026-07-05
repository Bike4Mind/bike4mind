import React, { useState } from 'react';
import { Modal, ModalDialog, Typography, Tooltip, Textarea, Chip, Stack, Button, Box } from '@mui/joy';
import { PromptMeta } from '@bike4mind/common';

import BugReportIcon from '@mui/icons-material/BugReport';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import FeedbackIcon from '@mui/icons-material/Feedback';
import { FeedbackType } from '@bike4mind/common';

import { createFeedbackOnServer } from '@client/app/utils/feedbackAPICalls';
import { useUser } from '@client/app/contexts/UserContext';
import { useTheme } from '@mui/joy';
import { toast } from 'sonner';

interface BugReportModalProps {
  open: boolean;
  className?: string;
  onClose: () => void;
  promptMeta: PromptMeta | null;
}

const BugReportModal: React.FC<BugReportModalProps> = ({ open, onClose, promptMeta }) => {
  const [bugReport, setBugReport] = useState('');
  const [feedbackType, setFeedbackType] = useState<FeedbackType>(FeedbackType.BUG);
  const userContext = useUser();
  const theme = useTheme();
  const handleFeedbackTypeChange = (type: FeedbackType) => {
    setFeedbackType(type);
  };

  const getIconStyle = (type: FeedbackType) => ({
    size: 'lg',
    color: feedbackType === type ? 'white' : 'inherit',
    bgcolor:
      feedbackType === type
        ? type === FeedbackType.BUG
          ? theme.palette.feedback.bug
          : type === FeedbackType.THUMBS_DOWN
            ? theme.palette.feedback.thumbsDown
            : type === FeedbackType.THUMBS_UP
              ? theme.palette.feedback.positive
              : theme.palette.feedback.feedback
        : 'transparent',
    borderRadius: '100%',
    cursor: 'pointer',
    width: '40px',
    height: '40px',
    padding: '5px',
    transition: 'all 0.3s ease',
    '&:hover': {
      bgcolor:
        type === FeedbackType.BUG
          ? theme.palette.feedback.bug
          : type === FeedbackType.THUMBS_DOWN
            ? theme.palette.feedback.thumbsDown
            : type === FeedbackType.THUMBS_UP
              ? theme.palette.feedback.positive
              : theme.palette.feedback.feedback,
      color: 'white',
    },
  });

  const handleSubmit = () => {
    console.log('Submitting bug report:', bugReport);
    createFeedbackOnServer({
      userId: userContext?.currentUser?.id ?? 'Unknown',
      username: userContext?.currentUser?.username ?? 'Unknown',
      userEmail: userContext?.currentUser?.email ?? 'Unknown',
      tags: ['bug', 'feedback', 'bugReport'],
      type: feedbackType,
      content: bugReport || 'No feedback details provided',
      promptMeta: promptMeta ?? {},
    });
    onClose();
    toast.success(`${feedbackType} report submitted successfully`);
    setBugReport('');
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog>
        <Stack direction="row" justifyContent="space-between">
          <Typography level="h1">Submit Bug & Feedback Report</Typography>
        </Stack>
        <Typography level="h4">Bad AI output?, broken feature, UI issue, or maybe good feedback?</Typography>
        <Stack direction="row" justifyContent="start" spacing={5}>
          <Tooltip title="Good AI output">
            <ThumbUpIcon
              sx={getIconStyle(FeedbackType.THUMBS_UP)}
              onClick={() => handleFeedbackTypeChange(FeedbackType.THUMBS_UP)}
            />
          </Tooltip>
          <Tooltip title="Bad AI output">
            <ThumbDownIcon
              sx={getIconStyle(FeedbackType.THUMBS_DOWN)}
              onClick={() => handleFeedbackTypeChange(FeedbackType.THUMBS_DOWN)}
            />
          </Tooltip>
          <Tooltip title="Bug">
            <BugReportIcon
              sx={getIconStyle(FeedbackType.BUG)}
              onClick={() => handleFeedbackTypeChange(FeedbackType.BUG)}
            />
          </Tooltip>
          <Tooltip title="Feedback">
            <FeedbackIcon
              sx={getIconStyle(FeedbackType.FEEDBACK)}
              onClick={() => handleFeedbackTypeChange(FeedbackType.FEEDBACK)}
            />
          </Tooltip>
        </Stack>
        <Box sx={{ mt: 2 }}>
          <Typography level="h3">Please give us as much information as possible to improve your experience.</Typography>
          <Textarea
            minRows={10}
            value={bugReport || ''}
            onChange={e => setBugReport(e.target.value)}
            sx={{ width: '100%', mt: 2, backgroundColor: 'grey' }}
          />
        </Box>
        <Chip color="success">
          <Typography level="body-md">
            Notebook, ai model, prompt, message and all other relevant information attached:
          </Typography>
        </Chip>
        <Box overflow="auto" maxHeight="10vh">
          <Typography level="body-sm">Prompt Meta:</Typography>
          <Typography level="body-xs">{JSON.stringify(promptMeta, null, 2)}</Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 2 }}>
          <Button onClick={onClose} variant="outlined">
            Cancel
          </Button>
          <Button onClick={handleSubmit} variant="solid">
            Submit
          </Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default BugReportModal;
