import { Button, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useQuestMasterUpgrade } from './questMasterUpgrade';

const QuestMasterUpgradePrompt = ({ onUpgrade }: { onUpgrade?: () => void }) => {
  const { isOpen, close } = useQuestMasterUpgrade();
  const setLLM = useLLM(s => s.setLLM);

  return (
    <Modal open={isOpen} onClose={close}>
      <ModalDialog aria-labelledby="questmaster-upgrade-title" data-testid="questmaster-upgrade-prompt">
        <ModalClose data-testid="questmaster-upgrade-close-btn" />
        <Typography id="questmaster-upgrade-title" level="h3">
          Continue with Questmaster
        </Typography>
        <Typography>
          {onUpgrade
            ? 'You have used your free Questmaster quest. Questmaster is included with every paid plan, or you can turn it off to keep chatting.'
            : 'You have used your free Questmaster quest. Ask your administrator about a paid plan, or turn Questmaster off to keep chatting.'}
        </Typography>
        <Stack direction="row" gap={1} sx={{ justifyContent: 'flex-end' }}>
          <Button variant="plain" onClick={close} data-testid="questmaster-upgrade-cancel-btn">
            Not now
          </Button>
          <Button
            variant="outlined"
            onClick={() => {
              close();
              setLLM({ isQuestMasterEnabled: false });
            }}
            data-testid="questmaster-upgrade-disable-btn"
          >
            Continue without Questmaster
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
