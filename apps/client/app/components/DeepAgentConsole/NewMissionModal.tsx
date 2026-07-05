import { FC, useState } from 'react';
import {
  Button,
  DialogContent,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Modal,
  ModalDialog,
  Option,
  Select,
  Stack,
  Switch,
  Textarea,
  Typography,
} from '@mui/joy';

export interface NewMissionValues {
  goal: string;
  role: string;
  enableTools: boolean;
}

interface NewMissionModalProps {
  open: boolean;
  agentName: string;
  onClose: () => void;
  onCreate: (values: NewMissionValues) => void;
  pending: boolean;
  errorMessage?: string | null;
}

/**
 * Give an existing agent a Mission - a standing goal it pursues across wakes
 * with its own memory, drives, and review trail. The agent's persona and tool
 * policy carry over automatically; only the WHAT is needed here.
 */
const NewMissionModal: FC<NewMissionModalProps> = ({ open, agentName, onClose, onCreate, pending, errorMessage }) => {
  const [goal, setGoal] = useState('');
  const [role, setRole] = useState('default');
  const [enableTools, setEnableTools] = useState(true);

  const canSubmit = goal.trim().length > 0 && !pending;

  return (
    <Modal open={open} onClose={() => !pending && onClose()}>
      <ModalDialog sx={{ width: 480 }} data-testid="new-mission-modal">
        <DialogTitle>New Mission for {agentName}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <FormControl required>
              <FormLabel>Mission goal</FormLabel>
              <Textarea
                minRows={3}
                value={goal}
                onChange={e => setGoal(e.target.value)}
                placeholder={`What should ${agentName} pursue across its wakes?`}
                data-testid="mission-goal-input"
              />
              <FormHelperText>
                {agentName}&apos;s persona, tools, and personality carry over automatically.
              </FormHelperText>
            </FormControl>
            <FormControl>
              <FormLabel>Work profile</FormLabel>
              <Select value={role} onChange={(_e, v) => v && setRole(v)} data-testid="mission-role-select">
                <Option value="default">default — general web work</Option>
                <Option value="paper-repro">paper-repro — deep research &amp; reproduction</Option>
              </Select>
            </FormControl>
            <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
              <div>
                <FormLabel>Enable tools on first wake</FormLabel>
                <FormHelperText>web search, code execution, knowledge retrieval</FormHelperText>
              </div>
              <Switch
                checked={enableTools}
                onChange={e => setEnableTools(e.target.checked)}
                data-testid="mission-tools-switch"
              />
            </FormControl>
            {pending && (
              <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                Enrolling the mission and running its first wake — {agentName} is orienting, acting, and reflecting.
                This takes 10–60s.
              </Typography>
            )}
            {errorMessage && !pending && (
              <Typography level="body-sm" color="danger" data-testid="mission-error">
                Mission creation failed: {errorMessage}
              </Typography>
            )}
            <Button
              onClick={() => onCreate({ goal: goal.trim(), role, enableTools })}
              disabled={!canSubmit}
              loading={pending}
              data-testid="mission-submit-btn"
            >
              Launch Mission
            </Button>
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default NewMissionModal;
