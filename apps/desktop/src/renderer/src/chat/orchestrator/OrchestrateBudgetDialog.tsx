import Button from '@mui/joy/Button';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import FormControl from '@mui/joy/FormControl';
import FormHelperText from '@mui/joy/FormHelperText';
import FormLabel from '@mui/joy/FormLabel';
import Input from '@mui/joy/Input';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import { useEffect, useState } from 'react';
import { parseBudgetCredits } from './runBudgetInput';

/**
 * Asked when Orchestrate turns on: the credit budget the whole run (planner and every agent it
 * starts) shares. Blank starts the run without one, as before.
 */
export function OrchestrateBudgetDialog({
  open,
  onCancel,
  onStart,
}: {
  open: boolean;
  onCancel(): void;
  onStart(budgetCredits: number | undefined): void;
}) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (open) setText('');
  }, [open]);
  const parsed = parseBudgetCredits(text);
  const invalid = parsed === undefined;
  const start = () => {
    if (!invalid) onStart(parsed ?? undefined);
  };

  return (
    <Modal open={open} onClose={onCancel}>
      <ModalDialog size="sm" sx={{ maxWidth: 380 }} data-testid="orchestrate-budget-dialog">
        <DialogTitle>Start orchestrating</DialogTitle>
        <DialogContent>
          <form
            onSubmit={event => {
              event.preventDefault();
              start();
            }}
          >
            <FormControl error={invalid}>
              <FormLabel>Credit budget for this run</FormLabel>
              <Input
                autoFocus
                inputMode="numeric"
                placeholder="No budget"
                value={text}
                onChange={event => setText(event.target.value)}
                endDecorator="credits"
                slotProps={{ input: { 'data-testid': 'orchestrate-budget-input' } }}
              />
              <FormHelperText>
                {invalid
                  ? 'Enter a whole number of credits, or leave it blank.'
                  : 'Shared by the planner and every agent it starts. The run pauses when it is used up, and you can raise it then.'}
              </FormHelperText>
            </FormControl>
          </form>
        </DialogContent>
        <DialogActions>
          <Button disabled={invalid} onClick={start} data-testid="orchestrate-budget-start-btn">
            Start
          </Button>
          <Button variant="plain" color="neutral" onClick={onCancel} data-testid="orchestrate-budget-cancel-btn">
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}
