import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useState } from 'react';
import { parseBudgetCredits } from './runBudgetInput';

/**
 * Under a turn its run's credit budget stopped: the only way the run resumes is a higher budget.
 * Raising it continues every session of the run the budget paused, this one included.
 */
export function RunBudgetRaiseRow({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseBudgetCredits(text);
  const valid = typeof parsed === 'number';

  const raise = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.b4m.chat.raiseRunBudget(sessionId, parsed);
      if (!result.ok) setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={0.5} sx={{ mt: 1 }} data-testid="chat-run-budget-row">
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Chip size="sm" color="warning" variant="soft" data-testid="chat-run-budget-chip">
          Paused - run budget used
        </Chip>
        <form
          onSubmit={event => {
            event.preventDefault();
            void raise();
          }}
          style={{ display: 'flex', gap: 8, alignItems: 'center' }}
        >
          <Input
            size="sm"
            inputMode="numeric"
            placeholder="New budget"
            value={text}
            onChange={event => setText(event.target.value)}
            endDecorator="credits"
            disabled={busy}
            sx={{ width: 180 }}
            slotProps={{ input: { 'aria-label': 'New run budget in credits', 'data-testid': 'chat-run-budget-input' } }}
          />
          <Button
            type="submit"
            size="sm"
            variant="soft"
            color="primary"
            loading={busy}
            disabled={!valid}
            data-testid="chat-run-budget-raise-btn"
          >
            Raise and resume
          </Button>
        </form>
      </Stack>
      {error && (
        <Typography level="body-xs" color="danger" data-testid="chat-run-budget-error">
          {error}
        </Typography>
      )}
    </Stack>
  );
}
