import { Button } from '@mui/joy';
import { toast } from 'sonner';
import { ModelWriteAction } from '../ModelWriteAction';
import { useModelsNavigation } from '../modelsNavigation';
import { useRunDiscoveryNow } from './runDiscoveryNow';

/**
 * The Models page's "Run discovery" header action: the Discovery section's Run now. When the run reports, the list
 * and prices refetch and a toast links to the run.
 */
export function RunDiscoveryButton({ 'data-testid': testId }: { 'data-testid'?: string }) {
  const { runNow, announceFinished, busy } = useRunDiscoveryNow();
  const { openSection } = useModelsNavigation();

  const run = async () => {
    const outcome = await runNow(announceFinished);
    if (outcome.kind === 'failed') {
      toast.error(
        outcome.message,
        outcome.discoveryOff
          ? { action: { label: 'Open settings', onClick: () => void openSection('settings') } }
          : undefined
      );
    } else if (outcome.kind === 'gave-up') {
      toast(outcome.message);
    }
  };

  return (
    <ModelWriteAction>
      {disabled => (
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={disabled || busy}
          loading={busy}
          loadingPosition="start"
          onClick={() => void run()}
          data-testid={testId}
        >
          Run discovery
        </Button>
      )}
    </ModelWriteAction>
  );
}
