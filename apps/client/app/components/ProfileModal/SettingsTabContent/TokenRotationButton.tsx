import { useState } from 'react';
import { Box, Button, Typography } from '@mui/joy';
import Refresh from '@mui/icons-material/Refresh';
import ConfirmActionModal from '../../ConfirmActionModal';
import { useRotateIntegrationToken, RotatableIntegration } from '@client/app/hooks/data/tokenRotation';

const ROTATION_MESSAGES: Record<RotatableIntegration, { title: string; description: string }> = {
  github: {
    title: 'Re-authorize GitHub?',
    description:
      'You will be redirected to GitHub to grant fresh permissions. Your existing repositories and settings will be preserved.',
  },
  atlassian: {
    title: 'Re-authorize Atlassian?',
    description:
      'You will be redirected to Atlassian to renew your connection. Your Jira and Confluence settings will be preserved.',
  },
  slack: {
    title: 'Re-authorize Slack?',
    description:
      'You will be redirected to Slack to renew your account link. Your notebook routing and agent settings will be preserved.',
  },
  notion: {
    title: 'Re-authorize Notion?',
    description: 'You will be redirected to Notion to renew your connection. Your workspace access will be preserved.',
  },
};

interface TokenRotationButtonProps {
  integration: RotatableIntegration;
  isConnected: boolean;
  lastRotationInitiatedAt?: Date | string | null;
}

const TokenRotationButton = ({ integration, isConnected, lastRotationInitiatedAt }: TokenRotationButtonProps) => {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { mutate, isPending } = useRotateIntegrationToken(integration);
  const messages = ROTATION_MESSAGES[integration];

  if (!isConnected) return null;

  const formattedDate = lastRotationInitiatedAt
    ? new Date(lastRotationInitiatedAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;

  const handleConfirm = () => {
    setConfirmOpen(false);
    mutate();
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
      {formattedDate && (
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          Last re-authorized: {formattedDate}
        </Typography>
      )}
      <Button
        variant="outlined"
        color="neutral"
        size="sm"
        startDecorator={<Refresh />}
        onClick={() => setConfirmOpen(true)}
        loading={isPending}
        data-testid={`${integration}-rotate-token-btn`}
      >
        Re-authorize
      </Button>

      <ConfirmActionModal
        open={confirmOpen}
        title={messages.title}
        description={messages.description}
        forwardButtonText="Re-authorize"
        backwardButtonText="Cancel"
        onGoForward={handleConfirm}
        onGoBackward={() => setConfirmOpen(false)}
        loading={isPending}
        data-testid={`${integration}-rotate-token-confirm-modal`}
      />
    </Box>
  );
};

export default TokenRotationButton;
