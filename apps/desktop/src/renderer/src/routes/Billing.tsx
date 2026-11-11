import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useNavigate } from '@tanstack/react-router';
import { useAuthState } from '../auth/useAuthState';
import { ArrowLeftIcon, BillingIcon } from '../chat/icons';
import { thinScrollbarSx } from '../chat/layout';
import { BillingSettings } from '../profile/BillingSettings';

export function Billing() {
  const auth = useAuthState();
  const navigate = useNavigate();
  return (
    <Stack sx={{ height: '100vh', bgcolor: 'background.body' }} data-testid="billing-screen">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider', px: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ maxWidth: 880, mx: 'auto', py: 1.25 }}>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Back to conversations"
            data-testid="billing-back-btn"
            onClick={() => void navigate({ to: '/' })}
          >
            <ArrowLeftIcon />
          </IconButton>
          <BillingIcon />
          <Typography level="title-sm">Billing</Typography>
        </Stack>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3, py: 3, ...thinScrollbarSx }}>
        <BillingSettings auth={auth} />
      </Box>
    </Stack>
  );
}
