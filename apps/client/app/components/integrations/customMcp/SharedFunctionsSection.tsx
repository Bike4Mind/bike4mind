import { Chip, Sheet, Stack, Typography } from '@mui/joy';
import type { ICallableFunctionShared } from '@bike4mind/common';
import { useCallableFunctionsEnabled, useSharedCallableFunctions } from '@client/app/hooks/data/callableFunctions';

const VIA: Record<ICallableFunctionShared['sharedVia'], string> = {
  person: 'Shared with you',
  project: 'Shared with a project you are in',
  organization: 'Shared with your organization',
};

/** Functions other people shared with this person; each stays pending review and cannot be called yet. */
export default function SharedFunctionsSection() {
  const enabled = useCallableFunctionsEnabled();
  const { data } = useSharedCallableFunctions();
  if (!enabled || !data || data.length === 0) return null;
  return (
    <Stack gap="8px" data-testid="shared-functions-section">
      <Typography level="title-sm">Functions shared with you</Typography>
      {data.map(fn => (
        <Sheet key={fn.id} variant="outlined" sx={{ borderRadius: '8px', p: 1.5 }} data-testid="shared-function-row">
          <Stack direction="row" gap="8px" alignItems="center" flexWrap="wrap">
            <Typography level="title-sm" sx={{ fontFamily: 'code' }}>
              {fn.slug}
            </Typography>
            <Chip size="sm" variant="soft" color="warning" data-testid="shared-function-status">
              Pending review
            </Chip>
          </Stack>
          <Typography level="body-sm" sx={{ mt: 0.5 }}>
            {fn.description}
          </Typography>
          <Typography level="body-xs" sx={{ color: 'text.secondary', mt: 0.5 }}>
            {VIA[fn.sharedVia]}, promotion {fn.pin.seq ?? ''}. It cannot be called until you review it.
          </Typography>
        </Sheet>
      ))}
    </Stack>
  );
}
