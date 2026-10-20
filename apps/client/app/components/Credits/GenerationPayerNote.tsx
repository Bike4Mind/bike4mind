import { Typography } from '@mui/joy';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { payerLabel } from '@client/app/hooks/data/generationBillingTarget';
import { useSelectedAccount } from './AccountSelector';

/** Who the next generation bills; renders nothing without a selected account or when credits are not enforced. */
const GenerationPayerNote = ({ 'data-testid': testId = 'generation-payer-note' }: { 'data-testid'?: string }) => {
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const label = payerLabel(useSelectedAccount(state => state.selectedAccount));
  if (!enforceCredits || !label) return null;

  return (
    <Typography level="body-xs" sx={{ alignSelf: 'flex-end' }} data-testid={testId}>
      Paid from {label}
    </Typography>
  );
};

export default GenerationPayerNote;
