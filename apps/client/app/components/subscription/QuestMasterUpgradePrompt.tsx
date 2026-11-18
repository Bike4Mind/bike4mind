import { Button, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import { useQuestMasterUpgrade } from './questMasterUpgrade';

const QuestMasterUpgradePrompt = ({ onUpgrade }: { onUpgrade?: () => void }) => {
  const { isOpen, close } = useQuestMasterUpgrade();

  return (
    <Modal open={isOpen} onClose={close}>
      <ModalDialog aria-labelledby="questmaster-upgrade-title" data-testid="questmaster-upgrade-prompt">
        <ModalClose data-testid="questmaster-upgrade-close-btn" />
        <Typography id="questmaster-upgrade-title" level="h3">
          Continue with Questmaster
        </Typography>
        <Typography>
          You have used your free Questmaster quest. Questmaster is included with every paid plan.
        </Typography>
        <Stack direction="row" gap={1} sx={{ justifyContent: 'flex-end' }}>
          <Button variant="plain" onClick={close} data-testid="questmaster-upgrade-cancel-btn">
            Not now
          </Button>
          {onUpgrade && (
            <Button
              onClick={() => {
                close();
                onUpgrade();
              }}
              data-testid="questmaster-upgrade-plans-btn"
            >
              View plans
            </Button>
          )}
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default QuestMasterUpgradePrompt;
