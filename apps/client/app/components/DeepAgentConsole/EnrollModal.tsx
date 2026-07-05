import { FC, useState } from 'react';
import {
  Button,
  DialogContent,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Modal,
  ModalDialog,
  Option,
  Select,
  Stack,
  Switch,
  Textarea,
  Typography,
} from '@mui/joy';

export interface EnrollFormValues {
  name: string;
  role: string;
  goal: string;
  enableTools: boolean;
}

interface EnrollModalProps {
  open: boolean;
  onClose: () => void;
  onEnroll: (values: EnrollFormValues) => void;
  pending: boolean;
  /** Enrollment failure to display (the modal stays open on error). */
  errorMessage?: string | null;
}

/** Birth certificate form: name, role (toolbelt profile), goal, tools toggle. */
const EnrollModal: FC<EnrollModalProps> = ({ open, onClose, onEnroll, pending, errorMessage }) => {
  const [name, setName] = useState('');
  const [role, setRole] = useState('default');
  const [goal, setGoal] = useState('');
  const [enableTools, setEnableTools] = useState(true);

  const canSubmit = name.trim().length > 0 && goal.trim().length > 0 && !pending;

  return (
    <Modal open={open} onClose={() => !pending && onClose()}>
      <ModalDialog sx={{ width: 480 }} data-testid="deep-agent-enroll-modal">
        <DialogTitle>Enroll a Deep Agent</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <FormControl required>
              <FormLabel>Name</FormLabel>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Spectral Scout"
                data-testid="enroll-name-input"
              />
            </FormControl>
            <FormControl>
              <FormLabel>Role</FormLabel>
              <Select value={role} onChange={(_e, v) => v && setRole(v)} data-testid="enroll-role-select">
                <Option value="default">default — general web agent</Option>
                <Option value="paper-repro">paper-repro — scientific reproduction</Option>
              </Select>
              <FormHelperText>Selects the toolbelt profile and run budget.</FormHelperText>
            </FormControl>
            <FormControl required>
              <FormLabel>Goal</FormLabel>
              <Textarea
                minRows={3}
                value={goal}
                onChange={e => setGoal(e.target.value)}
                placeholder="What should this agent pursue across its wakes?"
                data-testid="enroll-goal-input"
              />
            </FormControl>
            <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between' }}>
              <div>
                <FormLabel>Enable tools on first wake</FormLabel>
                <FormHelperText>web search, code execution, knowledge retrieval</FormHelperText>
              </div>
              <Switch
                checked={enableTools}
                onChange={e => setEnableTools(e.target.checked)}
                data-testid="enroll-tools-switch"
              />
            </FormControl>
            {pending && (
              <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                Enrolling and running the first wake — the agent is orienting, acting, and reflecting. This takes
                10–60s.
              </Typography>
            )}
            {errorMessage && !pending && (
              <Typography level="body-sm" color="danger" data-testid="enroll-error">
                Enrollment failed: {errorMessage}
              </Typography>
            )}
            <Button
              onClick={() => onEnroll({ name: name.trim(), role, goal: goal.trim(), enableTools })}
              disabled={!canSubmit}
              loading={pending}
              data-testid="enroll-submit-btn"
            >
              Enroll &amp; First Wake
            </Button>
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default EnrollModal;
