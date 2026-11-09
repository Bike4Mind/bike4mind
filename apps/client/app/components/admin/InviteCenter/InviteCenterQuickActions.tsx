import { Button, IconButton, Tooltip } from '@mui/joy';
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
    <>
        {isMobile ? (
          <>
            <Tooltip title="Quick invite">
              <IconButton
                size="sm"
                onClick={onQuickInvite}
                data-testid="invite-center-quick-invite-btn"
              >
                <PersonAddIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Generate codes">
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
              startDecorator={<PersonAddIcon />}
              onClick={onQuickInvite}
              data-testid="invite-center-quick-invite-btn"
            >
              Quick invite
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              startDecorator={<VpnKeyIcon />}
              onClick={onGenerateCodes}
              data-testid="invite-center-generate-codes-btn"
            >
              Generate codes
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
    </>
  );
};

export default InviteCenterQuickActions;
