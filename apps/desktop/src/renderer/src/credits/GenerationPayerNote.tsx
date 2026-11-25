import Typography from '@mui/joy/Typography';
import { payerLabel } from './payer';
import { useAccountSelection } from './useAccountSelection';

/** Who the next generation bills, as on the web's GenerationPayerNote. Nothing while signed out. */
export function GenerationPayerNote({ 'data-testid': testId }: { 'data-testid': string }) {
  const label = payerLabel(useAccountSelection().selection?.selected ?? null);
  if (!label) return null;
  return (
    <Typography level="body-xs" textColor="text.tertiary" data-testid={testId}>
      Paid from {label}
    </Typography>
  );
}
