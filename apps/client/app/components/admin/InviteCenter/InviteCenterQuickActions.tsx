import { Box, Button, IconButton, Stack, Tooltip } from '@mui/joy';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import { useIsMobile } from '@client/app/hooks/useIsMobile';

interface InviteCenterQuickActionsProps {
  onQuickInvite: () => void;
  onGenerateCodes: () => void;
  onPasteCsv: () => void;
}

const InviteCenterQuickActions = ({ onQuickInvite, onGenerateCodes, onPasteCsv }: InviteCenterQuickActionsProps) => {
  const isMobile = useIsMobile();
  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: 'sm',
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        mb: 1,
      }}
    >
      <Stack direction="row" spacing={1.5}>
        {isMobile ? (
          <>
            <Tooltip title="Quick Invite">
              <IconButton
                size="sm"
                variant="outlined"
                color="primary"
                onClick={onQuickInvite}
                data-testid="invite-center-quick-invite-btn"
              >
                <PersonAddIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Generate Codes">
              <IconButton
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={onGenerateCodes}
                data-testid="invite-center-generate-codes-btn"
              >
                <VpnKeyIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Paste CSV">
              <IconButton
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={onPasteCsv}
                data-testid="invite-center-paste-csv-btn"
              >
                <ContentPasteIcon />
              </IconButton>
            </Tooltip>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="outlined"
              color="primary"
              startDecorator={<PersonAddIcon />}
              onClick={onQuickInvite}
              data-testid="invite-center-quick-invite-btn"
            >
              + Quick Invite
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<VpnKeyIcon />}
              onClick={onGenerateCodes}
              data-testid="invite-center-generate-codes-btn"
            >
              Generate Codes
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<ContentPasteIcon />}
              onClick={onPasteCsv}
              data-testid="invite-center-paste-csv-btn"
            >
              Paste CSV
            </Button>
          </>
        )}
      </Stack>
    </Box>
  );
};

export default InviteCenterQuickActions;
